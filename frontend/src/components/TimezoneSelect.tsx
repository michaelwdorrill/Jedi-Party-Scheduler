import { controlClass } from './ui';

const FALLBACK_ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Australia/Sydney',
];

function listZones(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  if (supported) {
    try {
      return supported('timeZone');
    } catch {
      // fall through
    }
  }
  return FALLBACK_ZONES;
}

export default function TimezoneSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (zone: string) => void;
}) {
  const zones = listZones();

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={controlClass('lg', 'w-full')}
    >
      {zones.map((z) => (
        <option key={z} value={z}>
          {z.replace(/_/g, ' ')}
        </option>
      ))}
    </select>
  );
}
