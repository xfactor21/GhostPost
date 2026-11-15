export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.endsWith("/lib/auth.ts"))
    return {
      url: new URL("./auth-fixture.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  if (
    resolved.url.endsWith("/backend/store.ts") &&
    context.parentURL?.includes("/backend/platform")
  )
    return {
      url: new URL("./sql-store-fixture.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  return resolved;
}
