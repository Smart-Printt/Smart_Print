import { Icon } from '@/components/ui/Icon'
import { passwordChecks } from '@/utils/passwordPolicy'

function Rule({ met, label }: { met: boolean; label: string }) {
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12.5,
        color: met ? 'var(--color-success)' : 'var(--color-text-muted)',
      }}
    >
      <Icon name={met ? 'checkCircle' : 'xCircle'} size={14} />
      {label}
    </li>
  )
}

export function PasswordRules({ password }: { password: string }) {
  const checks = passwordChecks(password)
  return (
    <ul style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Rule met={checks.length} label="At least 8 characters" />
      <Rule met={checks.letter} label="Contains a letter" />
      <Rule met={checks.digit} label="Contains a number" />
    </ul>
  )
}
