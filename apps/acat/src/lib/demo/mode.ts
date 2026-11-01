// NEXT_PUBLIC_DEMO_MODE=on turns on the demo's screens, its private-path 404s and its upload refusals.
// The caps and persona sign-in follow PERSONA_SIGN_IN (./personas). It is read in the browser as well as
// on the server, so it is set at build time and at run time. Safe to import from client code.

export const demoMode = (): boolean => process.env.NEXT_PUBLIC_DEMO_MODE === "on";
