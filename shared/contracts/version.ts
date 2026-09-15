// DSK-003: frozen pipeline contract version shared by the main process and the renderer.
// Pure data module: no DOM, Electron, Node or filesystem imports are allowed in shared/contracts/.
export const DSK_CONTRACT_VERSION = 'dsk.v1' as const;
export type DskContractVersion = typeof DSK_CONTRACT_VERSION;
