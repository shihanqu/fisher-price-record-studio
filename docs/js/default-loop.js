// The loop the Record Designer starts with: eight bars in Ab major, a melody
// over a broken-chord accompaniment with three-note harmony on the strong
// beats (Ab Fm Db Eb, then Ab Cm Db Eb7), played twice around the disc.
// Never more than three notes sound together (the spring motor can only pluck
// about three tines at once) and no single tine plays two steps in a row.
export const DEFAULT_LOOP = {
  stepsPerBeat: 2,
  repeats: 2,
  text: [
    'Ab4+Ab5+C6 Eb5 Ab5 Eb5+Bb5 Ab4+C6 Eb5 Ab5+C6+Eb6 Eb5 | C5+Ab5+F6 F5 Ab5+Eb6 F5 C5+Ab5+C6 F5 Ab5 F5+Eb6 |',
    'Ab4+Ab5+Db6 F5 Ab5+F6 F5 Ab4+Db6+Ab6 F5 Ab5+G6 F5+F6 | Eb4+Bb5+G6 Bb4 Eb5+F6 Bb4 Eb4+G5+Eb6 Bb4 Eb5+Bb5+Db6 Bb4 |',
    'Ab4+C6+Eb6 C5 Eb5+Ab6 C5 Ab4+G6 C5 Eb5+C6+Eb6 C5 | Eb4+Eb6+G6 C5 G5 C5+F6 Eb4+C6+Eb6 C5 G5+C6 C5 |',
    'Ab4+Db6+F6 F5 Ab5+Ab6 F5 Ab4+F6+Bb6 F5 Ab5+Db6+Ab6 F5+F6 | Eb4+Bb5+G6 Bb4 Eb5+F6 Bb4 Eb4+G5+Eb6 Bb4 Eb5+Bb5+Db6 Bb4',
  ].join('\n'),
};
