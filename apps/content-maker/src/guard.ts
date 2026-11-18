/** Minimal shape of a grammY context that the guard needs (keeps it testable without grammY). */
export interface GuardCtx {
  from?: { id: number };
  chat?: { type: string };
}

/** Only the owner in a private chat gets through; everyone else is ignored silently. */
export function ownerOnly(ownerId: number) {
  return async (ctx: GuardCtx, next: () => Promise<unknown>): Promise<void> => {
    if (ctx.from?.id === ownerId && ctx.chat?.type === 'private') await next();
  };
}
