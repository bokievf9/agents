import type { ReceptionistDeps, ReceptionistIn, ReceptionistOut } from './receptionist.js';

/** The model step of the receptionist on Fira (`fira-lead.ts`), as the receptionist sees it (kept apart so the two modules do not import each other). */
export interface FiraLeadTurn {
  turn(d: ReceptionistDeps, i: ReceptionistIn): Promise<ReceptionistOut>;
}

let registered: FiraLeadTurn | null = null;
/** HQ registers its Fira lead manager at start when `FIRA_LEAD_MANAGER=on`; every receptionist turn without an explicit `fira` then uses it. */
export const registerFiraLead = (f: FiraLeadTurn | null): void => {
  registered = f;
};
export const registeredFiraLead = (): FiraLeadTurn | null => registered;
