import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Technocore Swarm Observatory',
  description:
    'A live, passive, coverage-aware visualization of public Technocore activity. Observed != complete.',
};

export const viewport: Viewport = {
  themeColor: '#04060a',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
