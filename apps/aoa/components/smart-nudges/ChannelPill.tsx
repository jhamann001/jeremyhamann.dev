import { Pill } from "@/components/ui";
import { CHANNEL_LABEL, channelTone } from "@/components/workflow";
import type { Channel } from "@/components/workflow";

// Thin wrapper over the shared Pill — keeps every channel→tone/label decision in
// the C0 status-tone helper (no inline conditionals per screen). Server-safe.
export function ChannelPill({ channel }: { channel: Channel }) {
  return <Pill tone={channelTone(channel)}>{CHANNEL_LABEL[channel]}</Pill>;
}
