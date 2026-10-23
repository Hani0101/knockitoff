// All player-facing text lives here so the game can be translated later.
export const strings = {
  title: 'Knock It Off',
  tagline: 'Everything on that table is a suggestion.',

  desktopOnlyTitle: 'Desktop only',
  desktopOnlyBody:
    'Knock It Off needs a keyboard and mouse. Come back on a computer and the cat will be waiting.',

  loadingLines: [
    'The cat is doing catnip...',
    "The cat is robbing a bank, wait until she's back...",
    'The cat is smuggling treats across the border...',
    'The cat is listening to Wadih El Sheikh and drifting in Zahle...',
    'The cat is doing flips...',
  ],
  loadingFailed: 'Something went wrong while loading. Try refreshing the page.',
  webglMissing: 'Your browser does not support WebGL2, which this game needs.',

  play: 'Play',
  controls: 'Controls',
  credits: 'Credits',
  back: 'Back',
  resume: 'Resume',
  quitToTitle: 'Quit to title',
  paused: 'Paused',
  clickToResume: 'Click to resume',

  sensitivity: 'Mouse sensitivity',
  invertY: 'Invert Y',
  volume: 'Volume',

  controlsList: [
    ['WASD / Arrow keys', 'Move'],
    ['Shift', 'Run'],
    ['Space', 'Jump (climbs ledges automatically)'],
    ['Mouse', 'Look'],
    ['Left click', 'Left paw swipe'],
    ['Right click', 'Right paw swipe'],
    ['Both buttons', 'Grab a small item'],
    ['Click (holding)', 'Throw, hold longer for more power'],
    ['F (holding)', 'Trick: toss it up, click at the top to spike'],
    ['M', 'Meow'],
    ['R', 'Reset the room'],
    ['Esc', 'Pause'],
  ] as [string, string][],

  spike: 'SPIKE!',
  creditsHeading: 'Made with',
} as const;
