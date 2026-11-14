import { AsyncLocalStorage } from "node:async_hooks";
export const session = new AsyncLocalStorage();
export const auth = {
  getSession: async () => ({
    data: session.getStore() ? { user: { id: session.getStore() } } : null,
  }),
};
