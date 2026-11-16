// Studio content shown on the public website.
// Rooms, rates, opening hours, the promo, GCash details, contact details and gallery photos are edited in the admin (/admin),
// so the studio owner can change them without touching code. Everything else lives here.

export const site = {
  name: 'DMG Studio',
  shortName: 'DMG Studio',
  tagline: 'Rehearsal studios for bands. Amps warm, kit tuned, you just plug in.',
  intro:
    'Backlined studios with a drum kit, amps and PA already up. Bring guitars, sticks and cables, and play. Pick an open hour on the board below and book it from your phone.',

  // Where people find you. The owner can override the contact details below in /admin/content; these are the defaults.
  address: ['10-U-A Baltazar St', 'Grace Park West, Caloocan, 1405 Metro Manila'],
  landmark: 'Near 5th Avenue LRT Station',
  // Used for the embedded map and the "Get directions" link. A plain address or place name works.
  mapsQuery: '10-U-A Baltazar St, Grace Park West, Caloocan, 1405 Metro Manila',

  // How people reach you
  phone: '0917 483 5387',
  email: 'dmgperformance@gmail.com',
  messenger: 'https://m.me/61592423610143',
  socials: [{ label: 'Facebook', href: 'https://www.facebook.com/profile.php?id=61592423610143' }],

  // Shown in the "Before you come" section
  houseRules: [
    'Arrive 10 minutes early so you can set up on time. Your slot ends on the hour.',
    'You can bring your own instruments, cables, sticks and picks.',
    'Food stays outside. Water in sealed bottles is fine.',
    'Damage to studio gear is charged at repair cost.',
    'No smoking or vaping inside the building.',
  ],

  faqs: [
    {
      q: 'Can I record my rehearsal?',
      a: 'Yes. Plug your phone or interface into the mixer for a stereo recording, or ask us for a multitrack demo session when you book.',
    },
    {
      q: 'How do I pay?',
      a: 'Pay at the studio when you arrive, or pay 50% or 100% by GCash when you book: scan the QR on the booking page, upload a screenshot of your receipt, and the studio confirms it. Your slot is held while you pay, and if you pay 50% the rest is due at the studio.',
    },
    {
      q: 'What if we run late?',
      a: 'You can’t extend a session online. If you want more time, tell the studio first. We can add an hour only if the next slot is still free. If someone booked after you, your session ends on time so theirs can start.',
    },
    {
      q: 'Can I cancel or move my booking?',
      a: 'Cancel online with your booking code and mobile number, up to the cutoff shown on your booking. To move a booking, message us.',
    },
  ],

  // Gallery photos are uploaded in /admin/content. These labels show on the placeholders until the first photo is added.
  galleryPlaceholders: ['Studio A, full band setup', 'Drum kit and cymbals', 'Amp wall', 'Mixer and PA', 'Waiting area'],
};
