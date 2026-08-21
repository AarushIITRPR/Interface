import Link from "next/link";

export default function Home() {
  return (
    <main className="landing-shell">
      <header className="landing-header">
        <span className="wordmark">Meridian</span>
        <span className="lab-mark">CVPR Lab, IIT Ropar</span>
      </header>
      <section className="landing-content">
        <p className="eyebrow">Research instrument</p>
        <h1>A calm path through a controlled session.</h1>
        <p className="landing-copy">Two stations. The subject sees one task at a time. The instructor sees everything else.</p>
        <div className="portal-grid" aria-label="Choose a portal">
          <Link className="portal-card" href="/subject">
            <span className="station">Station A</span><strong>Subject display</strong>
            <span>Full-screen guided experience with one clear task at a time.</span><b>Open</b>
          </Link>
          <Link className="portal-card" href="/instructor">
            <span className="station">Station B</span><strong>Instructor console</strong>
            <span>Run sessions, monitor recording health, intervene, and export.</span><b>Open</b>
          </Link>
        </div>
      </section>
    </main>
  );
}
