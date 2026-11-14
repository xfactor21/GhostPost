export default function Privacy() {
  return (
    <main className="policy panel">
      <a href="/" className="wordmark">
        Ghost<span className="pink">Post</span>
        <small>by planet.X ✕</small>
      </a>
      <h1>Privacy policy</h1>
      <p>
        Effective November 14, 2026. GhostPost is a private publishing workspace
        operated by planet.X.
      </p>
      <h2>Information we use</h2>
      <p>
        We store your account identity, drafts, destinations, manual posting
        records and sync diagnostics. If you connect Buffer, GhostPost reads
        your account, organizations, connected channels, queued posts and
        publishing history using your authorization. It does not publish social
        posts through the API in this alpha.
      </p>
      <h2>Storage and service providers</h2>
      <p>
        The application runs on Vercel. Neon provides account authentication and
        Postgres storage. Buffer provides authorized social account activity.
        Buffer access and refresh tokens are encrypted on the server using
        AES-256-GCM. Tokens and server credentials are excluded from workspace
        exports and are not stored in browser local storage.
      </p>
      <h2>Cookies and external links</h2>
      <p>
        Essential cookies support your sign-in session and protect Buffer
        authorization. Opening Buffer or a destination takes you to that
        provider, whose privacy policy applies. We do not sell your workspace
        data or use it for advertising.
      </p>
      <h2>Your choices</h2>
      <p>
        You can export your workspace, archive or restore records, disconnect
        Buffer to delete the saved credentials, and revoke GhostPost
        authorization in Buffer. Archiving preserves records for recovery; it
        does not permanently delete them. Contact us for account or workspace
        deletion. The earlier demo deployment has separate storage; migrating
        requires an export and import.
      </p>
      <h2>Security and retention</h2>
      <p>
        Workspace access is restricted to the signed-in account. Records remain
        until removed by the operator following a deletion request. Operational
        backups and provider logs follow each provider’s retention practices. No
        online service can guarantee absolute security.
      </p>
      <h2>Contact</h2>
      <p>
        For privacy questions or deletion requests:{" "}
        <a href="mailto:xfactor.planet.x@gmail.com">
          xfactor.planet.x@gmail.com
        </a>
        .
      </p>
    </main>
  );
}
