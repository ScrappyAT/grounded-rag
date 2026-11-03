import { redisConnection } from '../queue/client';

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  currentRequests: number;
  maxDailyRequests: number;
  currentCostUsd: number;
  maxDailyCostUsd: number;
}

export interface ReservationToken extends BudgetCheckResult {
  reservationId: string;
  dateKey: string;
  provisionalCostUsd: number;
  resolved: boolean;
}

export interface SettlementResult {
  success: boolean;
  status: string;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = 2000): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis operation timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * Atomic reservation Lua script.
 * Atomically checks capacity and reserves a request slot and provisional cost in Redis.
 * Also stores the reservation state as 'RESERVED' for Redis-side idempotency.
 */
const RESERVE_LUA_SCRIPT = `
local reqKey = KEYS[1]
local costKey = KEYS[2]
local resKey = KEYS[3]
local maxRequests = tonumber(ARGV[1])
local maxCostMicro = tonumber(ARGV[2])
local provisionalCostMicro = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])

local currentReq = tonumber(redis.call('get', reqKey) or '0')
local currentCost = tonumber(redis.call('get', costKey) or '0')

if currentReq >= maxRequests then
    return {0, 'DAILY_REQUEST_LIMIT_REACHED', currentReq, currentCost}
end

if (currentCost + provisionalCostMicro) > maxCostMicro then
    return {0, 'DAILY_BUDGET_LIMIT_REACHED', currentReq, currentCost}
end

local newReq = redis.call('incr', reqKey)
if newReq == 1 then
    redis.call('expire', reqKey, ttl)
end

local newCost = currentCost
if provisionalCostMicro > 0 then
    newCost = redis.call('incrby', costKey, provisionalCostMicro)
    if newCost == provisionalCostMicro then
        redis.call('expire', costKey, ttl)
    end
end

-- Store reservation state for Redis-side idempotency tracking
redis.call('set', resKey, 'RESERVED', 'EX', ttl)

return {1, 'ALLOWED', newReq, newCost}
`;

/**
 * Atomic reconciliation Lua script.
 * Reconciles the delta between actual generation cost and provisional reservation.
 *
 * State Invariant:
 * Strictly mutates counters ONLY when reservation state is exactly 'RESERVED'.
 * Rejects missing/expired keys and invalid states (RELEASED, RETAINED).
 * Idempotent: repeated calls on 'COMMITTED' return ALREADY_COMMITTED without double-counting.
 */
const RECONCILE_LUA_SCRIPT = `
local costKey = KEYS[1]
local tokensKey = KEYS[2]
local resKey = KEYS[3]
local deltaCostMicro = tonumber(ARGV[1])
local totalTokens = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

local resStatus = redis.call('get', resKey)

if not resStatus then
    return {0, 'RESERVATION_NOT_FOUND_OR_EXPIRED'}
end

if resStatus == 'COMMITTED' then
    return {1, 'ALREADY_COMMITTED'}
end

if resStatus ~= 'RESERVED' then
    return {0, 'INVALID_RESERVATION_STATE_' .. resStatus}
end

local currentCost = tonumber(redis.call('get', costKey) or '0')
local newCost = math.max(0, currentCost + deltaCostMicro)
redis.call('set', costKey, tostring(newCost))
redis.call('expire', costKey, ttl)

if totalTokens > 0 then
    local newTokens = redis.call('incrby', tokensKey, totalTokens)
    if newTokens == totalTokens then
        redis.call('expire', tokensKey, ttl)
    end
end

redis.call('set', resKey, 'COMMITTED', 'EX', ttl)

return {1, 'COMMITTED'}
`;

/**
 * Atomic release Lua script.
 * Releases provisional cost and decrements the request counter when a request fails before incurring provider cost.
 *
 * State Invariant:
 * Strictly mutates counters ONLY when reservation state is exactly 'RESERVED'.
 * Rejects missing/expired keys and invalid states (COMMITTED, RETAINED).
 * Idempotent: repeated calls on 'RELEASED' return ALREADY_RELEASED without double-reduction.
 * Guaranteed to maintain nonnegative counters.
 */
const RELEASE_LUA_SCRIPT = `
local reqKey = KEYS[1]
local costKey = KEYS[2]
local resKey = KEYS[3]
local provisionalCostMicro = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

local resStatus = redis.call('get', resKey)

if not resStatus then
    return {0, 'RESERVATION_NOT_FOUND_OR_EXPIRED'}
end

if resStatus == 'RELEASED' then
    return {1, 'ALREADY_RELEASED'}
end

if resStatus ~= 'RESERVED' then
    return {0, 'INVALID_RESERVATION_STATE_' .. resStatus}
end

local currentReq = tonumber(redis.call('get', reqKey) or '0')
if currentReq > 0 then
    redis.call('decr', reqKey)
else
    redis.call('set', reqKey, '0')
end
redis.call('expire', reqKey, ttl)

if provisionalCostMicro > 0 then
    local currentCost = tonumber(redis.call('get', costKey) or '0')
    local newCost = math.max(0, currentCost - provisionalCostMicro)
    redis.call('set', costKey, tostring(newCost))
    redis.call('expire', costKey, ttl)
end

redis.call('set', resKey, 'RELEASED', 'EX', ttl)

return {1, 'RELEASED'}
`;

/**
 * Atomic retain Lua script for uncertain provider outcomes.
 * Retains provisional reservation and records to uncertain bucket when an upstream outcome cannot be confirmed.
 *
 * State Invariant:
 * Strictly mutates counters ONLY when reservation state is exactly 'RESERVED'.
 * Rejects missing/expired keys and invalid states (COMMITTED, RELEASED).
 * Idempotent: repeated calls on 'RETAINED' return ALREADY_RETAINED without double-recording.
 */
const RETAIN_LUA_SCRIPT = `
local uncertainKey = KEYS[1]
local resKey = KEYS[2]
local provisionalCostMicro = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

local resStatus = redis.call('get', resKey)

if not resStatus then
    return {0, 'RESERVATION_NOT_FOUND_OR_EXPIRED'}
end

if resStatus == 'RETAINED' then
    return {1, 'ALREADY_RETAINED'}
end

if resStatus ~= 'RESERVED' then
    return {0, 'INVALID_RESERVATION_STATE_' .. resStatus}
end

redis.call('incrby', uncertainKey, provisionalCostMicro)
redis.call('expire', uncertainKey, ttl)
redis.call('set', resKey, 'RETAINED', 'EX', ttl)

return {1, 'RETAINED'}
`;

/**
 * Atomically checks and reserves request and cost capacity in Redis under concurrent execution.
 * Prevents race conditions and overspending bursts by executing an atomic Lua script.
 *
 * Provider-Side Overages Documentation:
 * Because LLM completions stream asynchronously and token consumption is only known after upstream completion,
 * a single concurrent request can theoretically incur costs that push the daily total slightly above DAILY_BUDGET_USD
 * by the delta of that single request. Grounded mitigates this by:
 * 1. Strict pre-allocation check: no request is dispatched if provisional cost exceeds remaining daily budget.
 * 2. Immediate reconciliation: once actual cost is returned, any excess is applied to the daily cost counter,
 *    immediately blocking all subsequent requests.
 * 3. Strict max_tokens limit (max_tokens: 1024) bounds the maximum possible cost overshoot per request to less than $0.001.
 * Complete hard-ceiling guarantees during active streaming require upstream provider-side controls
 * (e.g. DeepSeek console balance limits and monthly hard spending caps).
 */
export async function reserveDeepSeekCapacity(
  provisionalCostUsd = parseFloat(process.env.PROVISIONAL_COST_USD || '0.0005')
): Promise<ReservationToken> {
  const dateKey = new Date().toISOString().split('T')[0];
  const reservationId = `res_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const reqKey = `budget:deepseek:requests:${dateKey}`;
  const costKey = `budget:deepseek:cost_micro:${dateKey}`;
  const resKey = `budget:deepseek:reservation:${dateKey}:${reservationId}`;

  const maxDailyRequests = parseInt(process.env.DAILY_REQUEST_LIMIT || '500', 10);
  const maxDailyCostUsd = parseFloat(process.env.DAILY_BUDGET_USD || '2.00');
  const maxCostMicro = Math.round(maxDailyCostUsd * 1_000_000);
  const provisionalCostMicro = Math.round(provisionalCostUsd * 1_000_000);
  const ttlSeconds = 172800; // 48 hours

  const isProduction = process.env.NODE_ENV === 'production' || process.env.BUDGET_FAIL_CLOSED === 'true';

  try {
    const rawResult = await withTimeout(
      redisConnection.eval(
        RESERVE_LUA_SCRIPT,
        3,
        reqKey,
        costKey,
        resKey,
        maxDailyRequests,
        maxCostMicro,
        provisionalCostMicro,
        ttlSeconds
      ),
      2000
    ) as [number, string, number, number];

    const [allowedFlag, statusReason, count, costMicro] = rawResult;
    const allowed = allowedFlag === 1;

    if (!allowed) {
      let friendlyReason = statusReason;
      if (statusReason === 'DAILY_REQUEST_LIMIT_REACHED') {
        friendlyReason = `DAILY_REQUEST_LIMIT_REACHED: Daily ceiling of ${maxDailyRequests} requests reached (${count}/${maxDailyRequests}).`;
      } else if (statusReason === 'DAILY_BUDGET_LIMIT_REACHED') {
        friendlyReason = `DAILY_BUDGET_LIMIT_REACHED: Daily spending ceiling of $${maxDailyCostUsd.toFixed(2)} reached ($${(costMicro / 1_000_000).toFixed(4)}/$${maxDailyCostUsd.toFixed(2)}).`;
      }

      return {
        allowed: false,
        reservationId: '',
        dateKey,
        reason: friendlyReason,
        currentRequests: count,
        maxDailyRequests,
        currentCostUsd: costMicro / 1_000_000,
        maxDailyCostUsd,
        provisionalCostUsd: 0,
        resolved: true,
      };
    }

    return {
      allowed: true,
      reservationId,
      dateKey,
      currentRequests: count,
      maxDailyRequests,
      currentCostUsd: costMicro / 1_000_000,
      maxDailyCostUsd,
      provisionalCostUsd,
      resolved: false,
    };
  } catch (err: any) {
    console.error('[BudgetLimiter] Error executing atomic reservation in Redis:', err.message);

    // Fail-Closed Policy: In production, do not allow unmetered generation when budget tracking is down
    if (isProduction) {
      return {
        allowed: false,
        reservationId: '',
        dateKey,
        reason: 'BUDGET_VERIFICATION_UNAVAILABLE: Shared Redis budget controls are unreachable. Generation failed closed to protect API budget.',
        currentRequests: 0,
        maxDailyRequests,
        currentCostUsd: 0,
        maxDailyCostUsd,
        provisionalCostUsd: 0,
        resolved: true,
      };
    }

    // In non-production testing, permit with explicit warning
    return {
      allowed: true,
      reservationId: `dev_${Date.now()}`,
      dateKey,
      reason: 'DEVELOPMENT_FALLBACK: Redis unavailable, permitted in non-production mode.',
      currentRequests: 0,
      maxDailyRequests,
      currentCostUsd: 0,
      maxDailyCostUsd,
      provisionalCostUsd: 0,
      resolved: false,
    };
  }
}

/**
 * Reconciles provisionally reserved cost with actual token consumption and costs once generation completes.
 * Anchored to the original token's dateKey to correctly handle requests crossing midnight UTC.
 * Strictly mutates counters ONLY if reservation state in Redis is exactly 'RESERVED'.
 * Token is marked resolved ONLY after Redis confirms successful settlement (flag === 1).
 */
export async function reconcileDeepSeekConsumption(
  token: ReservationToken,
  promptTokens: number,
  completionTokens: number,
  actualCostUsd: number
): Promise<SettlementResult> {
  if (!token.reservationId || !token.allowed) {
    return { success: false, status: 'NO_VALID_RESERVATION' };
  }

  // Use original reservation dateKey to prevent midnight UTC rollover misattribution
  const dateKey = token.dateKey || new Date().toISOString().split('T')[0];
  const reservationId = token.reservationId;
  const costKey = `budget:deepseek:cost_micro:${dateKey}`;
  const tokensKey = `budget:deepseek:tokens:${dateKey}`;
  const resKey = `budget:deepseek:reservation:${dateKey}:${reservationId}`;

  const provisionalCostMicro = Math.round(token.provisionalCostUsd * 1_000_000);
  const actualCostMicro = Math.round(actualCostUsd * 1_000_000);
  const deltaCostMicro = actualCostMicro - provisionalCostMicro;
  const totalTokens = promptTokens + completionTokens;
  const ttlSeconds = 172800; // 48 hours

  try {
    const rawResult = await withTimeout(
      redisConnection.eval(
        RECONCILE_LUA_SCRIPT,
        3,
        costKey,
        tokensKey,
        resKey,
        deltaCostMicro,
        totalTokens,
        ttlSeconds
      ),
      2000
    ) as [number, string];

    const [allowedFlag, statusReason] = rawResult || [0, 'UNKNOWN_ERROR'];

    if (allowedFlag === 1) {
      // Mark resolved only after Redis confirms successful transition or safe idempotency
      token.resolved = true;
      return { success: true, status: statusReason };
    } else {
      console.warn(`[BudgetLimiter] Reconciliation rejected for ${reservationId}: ${statusReason}`);
      return { success: false, status: statusReason };
    }
  } catch (err: any) {
    console.error('[BudgetLimiter] Failed to reconcile consumption in Redis:', err.message);
    return { success: false, status: `REDIS_ERROR: ${err.message}` };
  }
}

/**
 * Releases a provisional reservation when a request definitely incurred NO provider costs
 * (e.g. pre-call refusal, HTTP 400 Bad Request, HTTP 401 Unauthorized, HTTP 429 Provider Rate Limit).
 * Anchored to original token dateKey (handles midnight rollover).
 * Strictly mutates counters ONLY if reservation state in Redis is exactly 'RESERVED'.
 * Token is marked resolved ONLY after Redis confirms successful settlement (flag === 1).
 */
export async function releaseDeepSeekReservation(token: ReservationToken): Promise<SettlementResult> {
  if (!token.reservationId || !token.allowed) {
    return { success: false, status: 'NO_VALID_RESERVATION' };
  }

  // Use original reservation dateKey to prevent midnight UTC rollover misattribution
  const dateKey = token.dateKey || new Date().toISOString().split('T')[0];
  const reservationId = token.reservationId;
  const reqKey = `budget:deepseek:requests:${dateKey}`;
  const costKey = `budget:deepseek:cost_micro:${dateKey}`;
  const resKey = `budget:deepseek:reservation:${dateKey}:${reservationId}`;
  const provisionalCostMicro = Math.round(token.provisionalCostUsd * 1_000_000);
  const ttlSeconds = 172800; // 48 hours

  try {
    const rawResult = await withTimeout(
      redisConnection.eval(
        RELEASE_LUA_SCRIPT,
        3,
        reqKey,
        costKey,
        resKey,
        provisionalCostMicro,
        ttlSeconds
      ),
      2000
    ) as [number, string];

    const [allowedFlag, statusReason] = rawResult || [0, 'UNKNOWN_ERROR'];

    if (allowedFlag === 1) {
      // Mark resolved only after Redis confirms successful transition or safe idempotency
      token.resolved = true;
      return { success: true, status: statusReason };
    } else {
      console.warn(`[BudgetLimiter] Release rejected for ${reservationId}: ${statusReason}`);
      return { success: false, status: statusReason };
    }
  } catch (err: any) {
    console.error('[BudgetLimiter] Failed to release reservation in Redis:', err.message);
    return { success: false, status: `REDIS_ERROR: ${err.message}` };
  }
}

/**
 * Retains provisional reservation when an upstream provider outcome is UNCERTAIN
 * (e.g. network timeout, connection abort mid-transmission, HTTP 504 Gateway Timeout, HTTP 500 error).
 * Anchored to original token dateKey (handles midnight rollover).
 * Strictly mutates counters ONLY if reservation state in Redis is exactly 'RESERVED'.
 * Token is marked resolved ONLY after Redis confirms successful settlement (flag === 1).
 */
export async function retainUncertainReservation(
  token: ReservationToken,
  reason: string
): Promise<SettlementResult> {
  if (!token.reservationId || !token.allowed) {
    return { success: false, status: 'NO_VALID_RESERVATION' };
  }

  const dateKey = token.dateKey || new Date().toISOString().split('T')[0];
  const reservationId = token.reservationId;
  const uncertainKey = `budget:deepseek:uncertain_cost_micro:${dateKey}`;
  const resKey = `budget:deepseek:reservation:${dateKey}:${reservationId}`;
  const provisionalCostMicro = Math.round(token.provisionalCostUsd * 1_000_000);
  const ttlSeconds = 172800; // 48 hours

  try {
    const rawResult = await withTimeout(
      redisConnection.eval(
        RETAIN_LUA_SCRIPT,
        2,
        uncertainKey,
        resKey,
        provisionalCostMicro,
        ttlSeconds
      ),
      2000
    ) as [number, string];

    const [allowedFlag, statusReason] = rawResult || [0, 'UNKNOWN_ERROR'];

    if (allowedFlag === 1) {
      token.resolved = true;
      console.warn(`[BudgetLimiter] Retained provisional reservation of $${token.provisionalCostUsd.toFixed(4)} due to uncertain provider outcome: ${reason} (status: ${statusReason})`);
      return { success: true, status: statusReason };
    } else {
      console.warn(`[BudgetLimiter] Retain rejected for ${reservationId}: ${statusReason}`);
      return { success: false, status: statusReason };
    }
  } catch (err: any) {
    console.error('[BudgetLimiter] Failed to record uncertain reservation in Redis:', err.message);
    return { success: false, status: `REDIS_ERROR: ${err.message}` };
  }
}

/**
 * Read-only budget inspection. Does not reserve capacity.
 */
export async function checkDeepSeekBudget(): Promise<BudgetCheckResult> {
  const dateKey = new Date().toISOString().split('T')[0];
  const reqKey = `budget:deepseek:requests:${dateKey}`;
  const costKey = `budget:deepseek:cost_micro:${dateKey}`;

  const maxDailyRequests = parseInt(process.env.DAILY_REQUEST_LIMIT || '500', 10);
  const maxDailyCostUsd = parseFloat(process.env.DAILY_BUDGET_USD || '2.00');
  const maxCostMicro = Math.round(maxDailyCostUsd * 1_000_000);

  const isProduction = process.env.NODE_ENV === 'production' || process.env.BUDGET_FAIL_CLOSED === 'true';

  try {
    const [reqCountStr, costMicroStr] = await withTimeout(
      Promise.all([
        redisConnection.get(reqKey),
        redisConnection.get(costKey),
      ]),
      2000
    );

    const currentRequests = reqCountStr ? parseInt(reqCountStr, 10) : 0;
    const currentCostMicro = costMicroStr ? parseInt(costMicroStr, 10) : 0;
    const currentCostUsd = currentCostMicro / 1_000_000;

    if (currentRequests >= maxDailyRequests) {
      return {
        allowed: false,
        reason: `DAILY_REQUEST_LIMIT_REACHED: Daily request ceiling of ${maxDailyRequests} requests has been reached (${currentRequests}/${maxDailyRequests}).`,
        currentRequests,
        maxDailyRequests,
        currentCostUsd,
        maxDailyCostUsd,
      };
    }

    if (currentCostMicro >= maxCostMicro) {
      return {
        allowed: false,
        reason: `DAILY_BUDGET_LIMIT_REACHED: Daily spending ceiling of $${maxDailyCostUsd.toFixed(2)} has been reached ($${currentCostUsd.toFixed(4)}/$${maxDailyCostUsd.toFixed(2)}).`,
        currentRequests,
        maxDailyRequests,
        currentCostUsd,
        maxDailyCostUsd,
      };
    }

    return {
      allowed: true,
      currentRequests,
      maxDailyRequests,
      currentCostUsd,
      maxDailyCostUsd,
    };
  } catch (err: any) {
    if (isProduction) {
      return {
        allowed: false,
        reason: 'BUDGET_VERIFICATION_UNAVAILABLE: Shared Redis budget controls are unreachable. Generation failed closed to protect API budget.',
        currentRequests: 0,
        maxDailyRequests,
        currentCostUsd: 0,
        maxDailyCostUsd,
      };
    }

    return {
      allowed: true,
      reason: 'DEVELOPMENT_FALLBACK: Redis unavailable, permitted in non-production mode.',
      currentRequests: 0,
      maxDailyRequests,
      currentCostUsd: 0,
      maxDailyCostUsd,
    };
  }
}

/**
 * Direct atomic recording for scenarios where pre-reservation was not used.
 */
export async function recordDeepSeekConsumption(
  promptTokens: number,
  completionTokens: number,
  costUsd: number
): Promise<void> {
  const dateKey = new Date().toISOString().split('T')[0];
  const reqKey = `budget:deepseek:requests:${dateKey}`;
  const costKey = `budget:deepseek:cost_micro:${dateKey}`;
  const tokensKey = `budget:deepseek:tokens:${dateKey}`;

  const costMicro = Math.round(costUsd * 1_000_000);
  const totalTokens = promptTokens + completionTokens;
  const ttlSeconds = 172800; // 48 hours

  try {
    const multi = redisConnection.multi();
    multi.incr(reqKey);
    multi.expire(reqKey, ttlSeconds);
    multi.incrby(tokensKey, totalTokens);
    multi.expire(tokensKey, ttlSeconds);
    multi.incrby(costKey, costMicro);
    multi.expire(costKey, ttlSeconds);
    await multi.exec();
  } catch (err: any) {
    console.error('[BudgetLimiter] Failed to persist consumption to Redis:', err.message);
  }
}
