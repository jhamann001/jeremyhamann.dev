import { notFound } from "next/navigation";
import {
  Card,
  CardHeader,
  CardBody,
  Button,
  Pill,
  Kpi,
  Avatar,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  SectionLabel,
  AiChip,
  ThemeToggle,
  Tabs,
  FieldList,
  Feed,
  FeedItem,
  StatTile,
  PreviewBadge,
} from "@/components/ui";
import type { PillTone } from "@/components/ui";
import { WorkflowPrimitivesDemo } from "./WorkflowPrimitivesDemo";

const TONES: PillTone[] = ["green", "gold", "blue", "amber", "red", "gray"];

// Dev-only component gallery. Disabled in production.
export default function ComponentGallery() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <main className="wrap">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ fontSize: 24 }}>UI components</h1>
        <ThemeToggle />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <Card>
          <CardHeader>
            <SectionLabel>Buttons</SectionLabel>
          </CardHeader>
          <CardBody>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <Button>Primary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="ghost" size="sm">Small ghost</Button>
              <AiChip />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <SectionLabel>Pills</SectionLabel>
          </CardHeader>
          <CardBody>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {TONES.map((t) => (
                <Pill key={t} tone={t} dot>
                  {t}
                </Pill>
              ))}
            </div>
          </CardBody>
        </Card>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
          <Card><Kpi label="Total AUM" value="$9.37M" delta="+2.4%" direction="up" /></Card>
          <Card><Kpi label="Households" value="5" /></Card>
          <Card><Kpi label="Net flows (30d)" value="-$120K" delta="-1.1%" direction="down" /></Card>
        </div>

        <Card>
          <CardHeader>
            <SectionLabel>Households</SectionLabel>
          </CardHeader>
          <CardBody style={{ padding: 0 }}>
            <Table>
              <THead>
                <TR>
                  <TH>Household</TH>
                  <TH>Lead advisor</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                <TR>
                  <TD>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <Avatar name="Stone Family" /> Stone Family Trust
                    </span>
                  </TD>
                  <TD>avery@example.com</TD>
                  <TD><Pill tone="green" dot>Active</Pill></TD>
                </TR>
                <TR>
                  <TD>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <Avatar name="Walker Household" /> Walker Household
                    </span>
                  </TD>
                  <TD>blake@example.com</TD>
                  <TD><Pill tone="amber" dot>Review</Pill></TD>
                </TR>
              </TBody>
            </Table>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <SectionLabel>Phase B primitives</SectionLabel>
            <PreviewBadge />
          </CardHeader>
          <CardBody>
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <Tabs
                tabs={[
                  { id: "overview", label: "Overview" },
                  { id: "detail", label: "Detail" },
                ]}
              >
                <FieldList
                  items={[
                    { label: "Objective", value: "Balanced growth with income" },
                    { label: "Restrictions", value: "No tobacco holdings" },
                    { label: "Rebalance band", value: "±5% from target" },
                  ]}
                />
                <Feed>
                  <FeedItem kind="note" time="10:20 AM" title="Call summary" desc="Discussed rebalancing and cash needs." />
                  <FeedItem kind="task" time="Yesterday" title="Sent proposal" desc="Advice plan v2 delivered for review." />
                  <FeedItem kind="event" time="2 days ago" title="Account funded" desc="Initial transfer posted to brokerage." />
                </Feed>
              </Tabs>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
                <StatTile label="Risk score" value="14 / 25" />
                <StatTile label="Cash reserve" value="6 mo" />
                <StatTile label="Accounts" value="4" />
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <SectionLabel>Phase C · Workflow primitives</SectionLabel>
            <PreviewBadge />
          </CardHeader>
          <CardBody>
            <WorkflowPrimitivesDemo />
          </CardBody>
        </Card>
      </div>
    </main>
  );
}
