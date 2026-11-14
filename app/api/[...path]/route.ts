import { handler } from "../../../backend";
export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const GET = handler,
  POST = handler,
  PUT = handler,
  DELETE = handler;
