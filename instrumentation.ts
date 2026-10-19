export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.ENABLE_HOURLY_SYNC === "false") return;
  const { startHourlySync } = await import("./lib/scheduler");
  startHourlySync();
}
