import { useSyncExternalStore } from 'react'
import { getPolicySnapshot, POLICY_KEYS, subscribePolicy } from './policy.ts'
import { refreshRemoteConfig } from './remoteConfig.ts'

// Shows the settings in force right now. Flip one in the Firebase console and it changes here live.
export function LiveSettings() {
  const { policy, status } = useSyncExternalStore(subscribePolicy, getPolicySnapshot)
  return (
    <div style={{ marginTop: 16, padding: 8, border: '1px solid #3a7' }}>
      <strong>Live settings (Firebase Remote Config)</strong>
      <table style={{ margin: '8px 0', borderCollapse: 'collapse' }}>
        <tbody>
          {POLICY_KEYS.map((key) => (
            <tr key={key}>
              <td style={{ paddingRight: 16, fontFamily: 'monospace' }}>{key}</td>
              <td style={{ fontFamily: 'monospace' }}>{String(policy[key])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <small>
        source: {status.source} · live updates: {status.live} · last fetch:{' '}
        {status.fetchedAt ? new Date(status.fetchedAt).toLocaleTimeString() : 'never'}
      </small>
      {status.error && <div><small>{status.error}</small></div>}
      {status.warnings.map((w) => <div key={w}><small>{w}</small></div>)}
      <div style={{ marginTop: 8 }}>
        <button onClick={() => void refreshRemoteConfig()}>Fetch now</button>
      </div>
    </div>
  )
}
