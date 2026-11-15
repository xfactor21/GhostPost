import { resolve as sqlResolve } from "./sql-loader.mjs";
export async function resolve(specifier, context, nextResolve) {
  const resolved = await sqlResolve(specifier, context, nextResolve);
  if (
    resolved.url.endsWith("/backend/media.ts") &&
    context.parentURL?.includes("/backend/index")
  )
    return {
      url: new URL("./media-fixture.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  return resolved;
}
