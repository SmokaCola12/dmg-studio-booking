// Studio content shown on the public website.
// Rooms, rates, opening hours, the promo and GCash details are edited in the admin (/admin),
// so the studio owner can change them without touching code. Everything else lives here.

export const site = {
  name: 'DMG Studio',
  shortName: 'DMG Studio',
  tagline: 'Rehearsal rooms for bands, open every day.',
  intro:
    'Full-band rooms with the drums, amps and PA already set up. Bring your instruments, plug in, and play. Book an hour or the whole night, right from your phone.',

  // Where people find you
  address: ['Unit 2, 123 Sample Street', 'Barangay Sample, Quezon City'],
  landmark: 'Beside the sample landmark, a short walk from the main road',
  // Used for the embedded map and the "Get directions" link. A plain address or place name works.
  mapsQuery: 'Quezon City Memorial Circle',

  // How people reach you
  phone: '0917 000 0000',
  email: 'hello@example.com',
  messenger: 'https://m.me/61592423610143',
  socials: [{ label: 'Facebook', href: 'https://www.facebook.com/profile.php?id=61592423610143' }],

  // Shown in the "Before you come" section
  houseRules: [
    'Arrive 10 minutes early so you can set up on time. Your slot ends on the hour.',
    'Bring your own instruments, cables, sticks and picks. Cymbals are provided in the bigger room.',
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
      a: 'Pay at the studio when you arrive, or send a GCash downpayment when you book. The booking page shows the GCash details.',
    },
    {
      q: 'What if we run late?',
      a: 'You can extend if the next hour is free. If someone booked after you, your session ends on time so theirs can start.',
    },
    {
      q: 'Can I cancel or move my booking?',
      a: 'Cancel online with your booking code and mobile number, up to the cutoff shown on your booking. To move a booking, message us.',
    },
  ],

  // Photos for the gallery. Put files in /public/gallery and list them here, e.g.
  // { src: '/gallery/room-a.jpg', alt: 'Room A with the drum kit set up' }
  // While this is empty, the gallery shows labeled placeholders.
  gallery: [],
  galleryPlaceholders: ['Room A, full band setup', 'Drum kit and cymbals', 'Amp wall', 'Room B for duos', 'Mixer and PA', 'Waiting area'],
};
