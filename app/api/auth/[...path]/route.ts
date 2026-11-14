import { auth } from '../../../../lib/auth';
const handlers = auth.handler();
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = async (...args: Parameters<typeof handlers.GET>) => {
  const response = await handlers.GET(...args);
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
};
export const POST = async (...args: Parameters<typeof handlers.POST>) => {
  const response = await handlers.POST(...args);
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
};
