export function custodianFeeScheduleMetadataOnlyEnabled(): boolean {
  return (
    process.env.EPIC_CUSTODIAN_DATABASE_AUTHORITY === "1" &&
    process.env.ENFORCE_CUSTODIAN_FEE_SCHEDULE_METADATA_ONLY === "1"
  );
}
