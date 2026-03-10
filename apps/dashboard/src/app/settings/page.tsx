import { getSettings } from "./actions";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const allSettings = await getSettings();

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
      <SettingsForm settings={allSettings} />
    </div>
  );
}
