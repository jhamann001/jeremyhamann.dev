import type { UserRef } from "@/types/domain";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Avatar plus display name. `null` renders a dashed placeholder labelled "Unassigned". */
export function UserAvatar({
  user,
  size = "md",
}: {
  user: UserRef | null;
  size?: "sm" | "md";
}): React.JSX.Element {
  const avatarSize = size === "sm" ? "sm" : "default";
  const textClass = size === "sm" ? "text-xs" : "text-sm";

  if (!user) {
    return (
      <span className={cn("inline-flex min-w-0 items-center gap-2 text-muted-foreground", textClass)}>
        <span
          aria-hidden
          className={cn(
            "inline-block shrink-0 rounded-full border border-dashed border-muted-foreground/60",
            size === "sm" ? "size-6" : "size-8",
          )}
        />
        <span className="truncate italic">Unassigned</span>
      </span>
    );
  }

  const label = user.name?.trim() || user.email;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2", textClass)} title={user.email}>
      <Avatar size={avatarSize}>
        {user.image ? <AvatarImage src={user.image} alt="" /> : null}
        <AvatarFallback className="font-medium">{initials(user.name, user.email)}</AvatarFallback>
      </Avatar>
      <span className="truncate">{label}</span>
    </span>
  );
}
