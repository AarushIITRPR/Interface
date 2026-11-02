export const COLOURS = [
  {name:"Red", hex:"#b83232"}, {name:"Blue", hex:"#245fa9"},
  {name:"Green", hex:"#34743b"}, {name:"Yellow", hex:"#d3a522"},
  {name:"Purple", hex:"#76509a"}, {name:"Orange", hex:"#c66728"},
];

export function makeStroopTrials(random = Math.random) {
  const trials: Array<{word:string; ink:string; hex:string}> = [];
  for (let block = 0; block < 5; block++) {
    const remaining = [...COLOURS];
    while (remaining.length) {
      // At a block boundary the last ink is back in the pool. Save it for later.
      const eligible = remaining.filter(colour => colour.name !== trials.at(-1)?.ink);
      const ink = eligible[Math.floor(random() * eligible.length)];
      remaining.splice(remaining.indexOf(ink), 1);

      // Keep the original word/ink relationship: 35% unrestricted, otherwise different.
      const words = random() < 0.35 ? COLOURS : COLOURS.filter(colour => colour !== ink);
      const word = words[Math.floor(random() * words.length)];
      trials.push({word:word.name.toUpperCase(), ink:ink.name, hex:ink.hex});
    }
  }
  return trials;
}
