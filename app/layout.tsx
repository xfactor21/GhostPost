import type { Metadata } from 'next';
import '../src/styles.css';
export const metadata: Metadata = {title:'GhostPost by planet.X',description:'Your private publishing workspace and Buffer companion.',robots:{index:false,follow:false}};
export default function Layout({children}:{children:React.ReactNode}) {return <html lang="en"><body>{children}</body></html>;}
