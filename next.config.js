/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: [
    '@xenova/transformers',
    'onnxruntime-node',
    'sharp',
    'pg',
    'ioredis',
    'bullmq',
    'pdfkit',
    'unpdf',
  ],
};

module.exports = nextConfig;

