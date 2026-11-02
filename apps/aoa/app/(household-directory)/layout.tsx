// Reuse the same authorization and shell without inheriting its loading file.
// app/layout.tsx remains the common root for client-side navigation.
export { default } from "@/app/(authenticated)/layout";
