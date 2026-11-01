import { redirect } from "next/navigation";

export default function Home(): React.JSX.Element {
  redirect("/dashboard");
}
