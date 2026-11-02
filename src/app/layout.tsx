import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Grounded — Enterprise Document Intelligence Assistant',
  description: 'Verifiable RAG Assistant for ApexPay Technologies with clickable source citations and calibrated refusal.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}

