import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '프로그램 참여관리',
  description: '센터 내부망에서 사용하는 로컬 프로그램 참여관리 시스템',
};

export default function RootLayout({ children }:{ children:React.ReactNode }) {
  return <html lang="ko"><body>{children}</body></html>;
}
