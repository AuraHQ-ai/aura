import { getSettings, getModelCatalog } from "./actions";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [allSettings, models] = await Promise.all([
    getSettings(),
    getModelCatalog(),
  ]);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
      <SettingsForm settings={allSettings} models={models} />
    </div>
  );
}
