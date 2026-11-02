const topics = [
  ["What could you pack for a picnic?", "Think about what to bring and how you’d use it."],
  ["What might you see in a park?", "Think about what people do there."],
  ["How would you make a simple snack?", "Talk through the steps in order."],
  ["What changes on a street when it rains?", "Think about what you might see or hear."],
  ["How would you explain a game to someone new?", "Pick any game and describe how to play."],
] as const;

export function SpeakingPrompt({elapsedSeconds}:{elapsedSeconds:number}) {
  const index = Math.max(0, Math.min(topics.length - 1, Math.floor(elapsedSeconds / 36)));
  const [question, hint] = topics[index];
  return <section className="speaking-prompt" aria-label="Speaking topic" aria-live="polite" aria-atomic="true">
    <div key={index} className="speaking-topic">
      <p className="live-subject-label">Topic {index + 1} of {topics.length}</p>
      <h2>{question}</h2>
      <p className="live-subject-description">{hint}</p>
    </div>
  </section>;
}
