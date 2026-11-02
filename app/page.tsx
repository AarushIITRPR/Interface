import Link from "next/link";

export default function Home() {
  return (
    <main className="landing-shell">
      <header className="landing-header">
        <span className="wordmark">Meridian</span>
        <span className="lab-mark">CVPR Lab, IIT Ropar</span>
      </header>
      <section className="landing-content">
        <h1>Choose your portal.</h1>

        <div className="portal-grid" aria-label="Choose a portal">
          <Link className="portal-card" href="/subject">
            <strong>Subject display</strong>
            <span>Join your session and follow the activities.</span><b>Open</b>
          </Link>
          <Link className="portal-card" href="/instructor">
            <strong>Instructor console</strong>
            <span>Prepare a session, monitor sensors, or review recordings.</span><b>Open</b>
          </Link>
        </div>
      </section>
    </main>
  );
}
