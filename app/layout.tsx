import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://onmaeum-program-care.mind-park.chatgpt.site'),
  title: '온마음 | 프로그램 참여관리',
  description: '정신건강 프로그램 신청, 출석, 참여이력과 확인서를 한곳에서 관리합니다.',
  openGraph: {
    title: '온마음 프로그램 참여관리',
    description: '신청부터 출석, 참여확인서까지 한곳에서',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: '온마음 프로그램 참여관리' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: '온마음 프로그램 참여관리',
    description: '신청부터 출석, 참여확인서까지 한곳에서',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
