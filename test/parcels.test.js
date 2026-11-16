const test = require('node:test');
const assert = require('node:assert/strict');
const {normalise, htmlToText, forwardingConfirmation} = require('../lib/mail');
const {validate, hintFits, merge, forToday, stale, placeOf, addresses, looksLikeShipping, carrierFromCode} = require('../lib/parcels');

const now = new Date('2026-10-19T08:00:00+02:00');

const mail = (over = {}) =>
	normalise({
		FromFull: {Email: 'noreply@notificatie.postnl.nl', Name: 'PostNL'},
		Subject: 'Je pakket van Coolblue komt vandaag',
		Date: '2026-10-19T07:12:00+02:00',
		HtmlBody:
			'<p>Goed nieuws! Je pakket komt <b>vandaag</b> tussen 14:00 en 16:30.</p><p>Track &amp; Trace: 3SCOOL1234567</p><a href="https://jouw.postnl.nl/track-and-trace/3SCOOL1234567-NL-1067AB">Volg je pakket</a>',
		...over,
	});

const shipment = (over = {}) => ({
	carrier: 'postnl',
	tracking_code: '3SCOOL1234567',
	postal_code: '1067 AB',
	status: 'out_for_delivery',
	expected_date: '2026-10-19',
	window_start: '14:00',
	window_end: '16:30',
	...over,
});
const answer = (shipments = [shipment()], over = {}) => ({is_shipping_email: true, shop: 'Coolblue', shipments, confidence: 0.95, ...over});

/* ---------- reading emails ---------- */

test('html is turned into text with links kept', () => {
	const text = htmlToText('<p>Hi&nbsp;there</p><a href="https://x.nl/t/ABC">Track</a><style>p{}</style>');
	assert.match(text, /Hi there/);
	assert.match(text, /Track \(https:\/\/x\.nl\/t\/ABC\)/);
	assert.doesNotMatch(text, /p\{\}/);
});

test('every email gets a stable id; Message-ID wins when present', () => {
	assert.equal(mail().id, mail().id);
	const a = normalise({Subject: 'a', TextBody: 'x', Headers: [{Name: 'Message-ID', Value: '<1@shop>'}]});
	const b = normalise({Subject: 'different', TextBody: 'y', Headers: [{Name: 'Message-Id', Value: '<1@shop>'}]});
	assert.equal(a.id, b.id);
});

test('newsletters are recognised without asking Claude', () => {
	assert.equal(looksLikeShipping(mail()), true);
	assert.equal(looksLikeShipping(normalise({Subject: '50% korting op alles!', TextBody: 'Alleen dit weekend bij Bershka.'})), false);
});

test('a tracking code can name its carrier', () => {
	assert.equal(carrierFromCode('3STWMB2393758'), 'postnl');
	assert.equal(carrierFromCode('JVGL06123456789012'), 'dhl');
	assert.equal(carrierFromCode('1Z999AA10123456784'), 'ups');
	assert.equal(carrierFromCode('123456'), null);
});

/* ---------- checking Claude's reading ---------- */

test('a good reading passes and is cleaned up', () => {
	const {readings, rejected} = validate(answer(), mail(), now);
	assert.deepEqual(rejected, []);
	assert.equal(readings[0].code, '3SCOOL1234567');
	assert.equal(readings[0].postalCode, '1067AB');
	assert.equal(readings[0].windowStart, '14:00');
});

test('a tracking code that is not in the email is rejected', () => {
	const {readings, rejected} = validate(answer([shipment({tracking_code: '3SCOOL7654321'})]), mail(), now);
	assert.equal(readings.length, 0);
	assert.match(rejected[0], /isn't in the email/);
});

test('newsletters, order confirmations and low confidence give no parcel', () => {
	assert.deepEqual(validate({is_shipping_email: false, shipments: [], confidence: 0.9}, mail(), now).rejected, ['not a shipping email']);
	assert.match(validate(answer([]), mail(), now).rejected[0], /no tracking code yet/);
	assert.match(validate(answer(undefined, {confidence: 0.3}), mail(), now).rejected[0], /low confidence/);
});

test('a split order gives one reading per tracking code, and repeats are dropped', () => {
	const m = mail({HtmlBody: '<p>Je bestelling komt in 2 pakketten: 3SBOL0000001 en 3SBOL0000002.</p>'});
	const {readings} = validate(
		answer([shipment({tracking_code: '3SBOL0000001'}), shipment({tracking_code: '3SBOL0000002'}), shipment({tracking_code: '3SBOL0000001'})]),
		m,
		now
	);
	assert.deepEqual(readings.map((r) => r.code), ['3SBOL0000001', '3SBOL0000002']);
});

test("the code's own carrier beats Claude's guess", () => {
	const {readings} = validate(answer([shipment({carrier: 'other'})]), mail(), now);
	assert.equal(readings[0].carrier, 'postnl');
});

test('implausible dates and half windows are dropped, not shown', () => {
	const {readings} = validate(answer([shipment({expected_date: '2027-06-01', window_start: '16:30', window_end: null})]), mail(), now);
	assert.equal(readings[0].expectedDate, null);
	assert.equal(readings[0].windowStart, null);
});

/* ---------- many emails, one parcel ---------- */

const reading = (over = {}) => ({carrier: 'postnl', code: '3SBERSHKA001', postalCode: null, shop: null, status: 'shipped', expectedDate: null, windowStart: null, windowEnd: null, ...over});
const email = (date, subject = 'x') => ({subject, date});

test('the shop email and the carrier email land on one parcel', () => {
	const shop = merge(null, reading({carrier: 'other', shop: 'Bershka'}), email('2026-10-17T10:00:00+02:00', 'Je bestelling is verzonden'));
	const carrier = merge(shop, reading({status: 'out_for_delivery', postalCode: '1067AB', expectedDate: '2026-10-19', windowStart: '14:00', windowEnd: '16:30'}), email('2026-10-19T07:00:00+02:00', 'Je pakket komt vandaag'));
	assert.equal(carrier.key, '3SBERSHKA001');
	assert.equal(carrier.carrier, 'postnl');
	assert.equal(carrier.shop, 'Bershka');
	assert.equal(carrier.status, 'out_for_delivery');
	assert.equal(carrier.seenIn.length, 2);
});

test('the same email twice changes nothing', () => {
	const once = merge(null, reading({status: 'out_for_delivery', expectedDate: '2026-10-19'}), email('2026-10-19T07:00:00+02:00'));
	const twice = merge(once, reading({status: 'out_for_delivery', expectedDate: '2026-10-19'}), email('2026-10-19T07:00:00+02:00'));
	assert.deepEqual({...twice, updatedAt: null}, {...once, updatedAt: null});
});

test('an old email arriving late cannot undo newer news', () => {
	const today = merge(null, reading({status: 'out_for_delivery', expectedDate: '2026-10-19', windowStart: '14:00', windowEnd: '16:30'}), email('2026-10-19T07:00:00+02:00'));
	const late = merge(today, reading({status: 'shipped', expectedDate: '2026-10-21'}), email('2026-10-17T10:00:00+02:00'));
	assert.equal(late.status, 'out_for_delivery');
	assert.equal(late.expectedDate, '2026-10-19');
	assert.equal(late.windowStart, '14:00');
});

test('a rescheduled day replaces the old one and clears its window', () => {
	const first = merge(null, reading({expectedDate: '2026-10-19', windowStart: '14:00', windowEnd: '16:30'}), email('2026-10-18T18:00:00+02:00'));
	const moved = merge(first, reading({expectedDate: '2026-10-20'}), email('2026-10-19T09:00:00+02:00'));
	assert.equal(moved.expectedDate, '2026-10-20');
	assert.equal(moved.windowStart, null);
});

test('a failed delivery shows, a new attempt replaces it, and delivered is final', () => {
	let p = merge(null, reading({status: 'out_for_delivery'}), email('2026-10-19T07:00:00+02:00'));
	p = merge(p, reading({status: 'delivery_failed'}), email('2026-10-19T15:00:00+02:00'));
	assert.equal(p.status, 'delivery_failed');
	p = merge(p, reading({status: 'out_for_delivery'}), email('2026-10-20T07:00:00+02:00'));
	assert.equal(p.status, 'out_for_delivery');
	p = merge(p, reading({status: 'delivered'}), email('2026-10-20T13:00:00+02:00'));
	p = merge(p, reading({status: 'delivery_failed'}), email('2026-10-20T14:00:00+02:00'));
	assert.equal(p.status, 'delivered');
	assert.equal(p.deliveredAt, '2026-10-20T13:00:00+02:00');
});

/* ---------- the TV ---------- */

test('only today matters on the TV', () => {
	const parcels = [
		{key: 'a', carrier: 'postnl', status: 'out_for_delivery', expectedDate: '2026-10-19', windowStart: '14:00', windowEnd: '16:30'},
		{key: 'b', carrier: 'dhl', status: 'shipped', expectedDate: '2026-10-21'},
		{key: 'c', carrier: 'dhl', status: 'delivered', deliveredAt: '2026-10-19T07:48:00+02:00'},
		{key: 'd', carrier: 'dpd', status: 'delivered', deliveredAt: '2026-10-18T11:00:00+02:00'},
	];
	const items = forToday(parcels, now);
	assert.equal(items.length, 2);
	assert.deepEqual(items[0], {carrier: 'DHL', for: null, shop: null, status: 'delivered 07:48', window: null, step: 3, verified: true});
	assert.equal(items[1].window, '14:00–16:30');
	assert.deepEqual(stale(parcels.map((p) => ({...p, updatedAt: now.toISOString()})), now), ['d']);
});

test('parcels know whose address they go to', () => {
	const env = {HOME_POSTCODE: '1102 ab', OTHER_ADDRESSES: 'Senia=3628AD;Broken=xx'};
	assert.deepEqual(addresses(env), [{label: 'home', postcode: '1102AB'}, {label: 'Senia', postcode: '3628AD'}]);
	assert.equal(placeOf('3628AD', env), 'Senia');
	assert.equal(placeOf(null, env), null);
	const parcels = [
		{key: 'a', carrier: 'postnl', status: 'out_for_delivery', place: 'Senia'},
		{key: 'b', carrier: 'dhl', status: 'out_for_delivery', place: 'home'},
	];
	assert.deepEqual(forToday(parcels, now).map((p) => p.for), ['Senia', null]);
	assert.equal(forToday(parcels, now, 'Europe/Amsterdam', {otherDeliveries: 'hide'}).length, 1);
});

test("Proton's forwarding confirmation is recognised and its link kept", () => {
	const m = normalise({
		from: 'no-reply@proton.me',
		subject: 'borys wants to forward emails to you',
		html: '<p>Accept forwarding</p><a href="https://account.proton.me/forwarding/accept?token=abc">Accept</a>',
	});
	assert.deepEqual(forwardingConfirmation(m), {link: 'https://account.proton.me/forwarding/accept?token=abc'});
	assert.equal(forwardingConfirmation(mail()), null);
});

/* ---------- the whole inbound path, Claude and storage faked ---------- */

function fakeWorld(claudeAnswer) {
	const answers = Array.isArray(claudeAnswer) ? [...claudeAnswer] : null;
	const store = {hash: {}, keys: {}, log: []};
	let claudeCalls = 0;
	const realFetch = global.fetch;
	global.fetch = async (url, opts = {}) => {
		if (String(url).startsWith('https://api.anthropic.com')) {
			claudeCalls++;
			assert.equal(JSON.parse(opts.body).tool_choice.name, 'record_shipments');
			return new Response(JSON.stringify({content: [{type: 'tool_use', input: answers ? answers.shift() : claudeAnswer}]}));
		}
		const [cmd, ...args] = JSON.parse(opts.body);
		let result = null;
		if (cmd === 'HGETALL') result = Object.entries(store.hash).flat();
		if (cmd === 'HSET') store.hash[args[1]] = args[2];
		if (cmd === 'HDEL') args.slice(1).forEach((k) => delete store.hash[k]);
		if (cmd === 'EXISTS') result = store.keys[args[0]] ? 1 : 0;
		if (cmd === 'SET') {
			if (args.includes('NX') && store.keys[args[0]]) result = null;
			else {
				store.keys[args[0]] = args[1];
				result = 'OK';
			}
		}
		if (cmd === 'DEL') delete store.keys[args[0]];
		if (cmd === 'LPUSH' && args[0] === 'inbound:log') store.log.unshift(JSON.parse(args[1]));
		if (cmd === 'LPUSH' && args[0] === 'parcel:hints') (store.hints = store.hints || []).unshift(args[1]);
		if (cmd === 'LRANGE' && args[0] === 'parcel:hints') result = store.hints || [];
		if (cmd === 'LREM') store.hints = (store.hints || []).filter((h) => h !== args[2]);
		return new Response(JSON.stringify({result}));
	};
	return {store, calls: () => claudeCalls, restore: () => (global.fetch = realFetch)};
}

const env = {ANTHROPIC_API_KEY: 'k', UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 't', HOME_POSTCODE: '1067AB'};

test('inbound: a parcel is stored, and the same email again is skipped', async () => {
	const world = fakeWorld(answer());
	try {
		const {handle} = require('../api/inbound');
		const first = await handle(mail(), env);
		assert.deepEqual(first, {result: 'parcel', parcels: [{key: '3SCOOL1234567', status: 'out_for_delivery'}]});
		assert.equal(JSON.parse(world.store.hash['3SCOOL1234567']).place, 'home');
		assert.deepEqual(await handle(mail(), env), {result: 'duplicate'});
		assert.equal(world.calls(), 1);
		assert.equal(Object.keys(world.store.keys).filter((k) => k.startsWith('lock:')).length, 0);
	} finally {
		world.restore();
	}
});

test('inbound: a newsletter never reaches Claude', async () => {
	const world = fakeWorld(answer());
	try {
		const {handle} = require('../api/inbound');
		const out = await handle(normalise({Subject: 'Nieuwe collectie!', TextBody: 'Shop nu de nieuwste looks.'}), env);
		assert.equal(out.result, 'ignored');
		assert.equal(world.calls(), 0);
	} finally {
		world.restore();
	}
});

test('inbound: an old carrier:code record is folded into the code-keyed one', async () => {
	const world = fakeWorld(answer());
	world.store.hash['postnl:3SCOOL1234567'] = JSON.stringify({key: 'postnl:3SCOOL1234567', carrier: 'postnl', code: '3SCOOL1234567', status: 'shipped', shop: 'Coolblue'});
	try {
		const {handle} = require('../api/inbound');
		await handle(mail(), env);
		assert.deepEqual(Object.keys(world.store.hash), ['3SCOOL1234567']);
		assert.equal(JSON.parse(world.store.hash['3SCOOL1234567']).status, 'out_for_delivery');
	} finally {
		world.restore();
	}
});

/* ---------- ranges of days, and emails without a tracking code ---------- */

const zalandoMail = (over = {}) =>
	normalise({
		FromFull: {Email: 'info@service-mail.zalando.nl', Name: 'Zalando'},
		Subject: 'Jouw pakket wordt tussen 17.11. en 18.11. geleverd',
		Date: '2026-11-16T18:10:49+01:00',
		TextBody: 'Je bestelling is onderweg met PostNL. Track & Trace: 3STBKH585136340',
		...over,
	});
const postnlMail = (over = {}) =>
	normalise({
		FromFull: {Email: 'notificatie@edm.postnl.nl', Name: 'PostNL'},
		Subject: 'Verwacht: je pakket van Zalando',
		Date: '2026-11-16T17:14:00+01:00',
		TextBody: 'Je pakket van Zalando wordt dinsdag 17 november bezorgd tussen 13:15 en 15:15. Volg je pakket (https://click.edm.postnl.nl/abc)',
		...over,
	});
const nov16 = new Date('2026-11-16T19:00:00+01:00');
const zalandoAnswer = {is_shipping_email: true, shop: 'Zalando', confidence: 0.95, shipments: [{carrier: 'postnl', tracking_code: '3STBKH585136340', status: 'shipped', expected_date: '2026-11-17', expected_date_last: '2026-11-18'}]};
const postnlAnswer = (over = {}) => ({is_shipping_email: true, shop: 'Zalando', confidence: 0.9, known_parcel: null, shipments: [{carrier: 'postnl', tracking_code: null, status: 'shipped', expected_date: '2026-11-17', window_start: '13:15', window_end: '15:15'}], ...over});

test('a range of days is kept, and shown on each of its days', () => {
	const {readings} = validate(zalandoAnswer, zalandoMail(), nov16);
	assert.equal(readings[0].expectedDate, '2026-11-17');
	assert.equal(readings[0].expectedDateLast, '2026-11-18');
	const parcel = merge(null, readings[0], zalandoMail());
	assert.equal(forToday([parcel], nov16).length, 0);
	assert.equal(forToday([parcel], new Date('2026-11-17T09:00:00+01:00'))[0].status, 'expected today or tomorrow');
	assert.equal(forToday([parcel], new Date('2026-11-18T09:00:00+01:00'))[0].status, 'expected today');
	assert.equal(forToday([parcel], new Date('2026-11-19T09:00:00+01:00')).length, 0);
	// a later email with one day narrows the range
	const narrowed = merge(parcel, {...readings[0], expectedDate: '2026-11-17', expectedDateLast: null, windowStart: '13:15', windowEnd: '15:15'}, {date: '2026-11-17T07:00:00+01:00', subject: 'Vandaag'});
	assert.equal(narrowed.expectedDateLast, null);
	assert.equal(narrowed.windowStart, '13:15');
});

test('a backwards or long range is dropped, the first day kept', () => {
	const shipments = [{...zalandoAnswer.shipments[0], expected_date_last: '2026-11-16'}];
	assert.equal(validate({...zalandoAnswer, shipments}, zalandoMail(), nov16).readings[0].expectedDateLast, null);
	shipments[0].expected_date_last = '2026-12-01';
	const r = validate({...zalandoAnswer, shipments}, zalandoMail(), nov16).readings[0];
	assert.deepEqual([r.expectedDate, r.expectedDateLast], ['2026-11-17', null]);
});

test('an email without a code is matched to a known parcel of the same shop', () => {
	const known = [{key: '3STBKH585136340', code: '3STBKH585136340', carrier: 'postnl', shop: 'Zalando', status: 'shipped'}];
	const {readings, rejected} = validate(postnlAnswer({known_parcel: '3STBKH585136340'}), postnlMail(), nov16, known);
	assert.deepEqual(rejected, []);
	assert.equal(readings[0].code, '3STBKH585136340');
	assert.equal(readings[0].matched, true);
	assert.equal(readings[0].windowStart, '13:15');
});

test('a codeless match is refused when it is not believable', () => {
	const known = [
		{code: '3STBKH585136340', carrier: 'postnl', shop: 'Zalando', status: 'shipped'},
		{code: 'JVGL0612345678', carrier: 'dhl', shop: 'Coolblue', status: 'shipped'},
		{code: '3SDONE00000001', carrier: 'postnl', shop: 'Zalando', status: 'delivered'},
	];
	const no = (ans) => validate(ans, postnlMail(), nov16, known).readings.length;
	assert.equal(no(postnlAnswer({known_parcel: 'JVGL0612345678'})), 0); // Coolblue isn't in the email
	assert.equal(no(postnlAnswer({known_parcel: '3SNOTKNOWN0001'})), 0); // not a known parcel
	assert.equal(no(postnlAnswer({known_parcel: '3SDONE00000001'})), 0); // already delivered
	assert.equal(no(postnlAnswer({known_parcel: '3STBKH585136340', confidence: 0.6})), 0); // unsure
	assert.equal(no(postnlAnswer({known_parcel: '3STBKH585136340', shipments: [{carrier: 'dhl', tracking_code: null, status: 'shipped', expected_date: '2026-11-17'}]})), 0); // other carrier
	const confirmation = validate(postnlAnswer({known_parcel: '3STBKH585136340', shipments: [{carrier: null, tracking_code: null, status: 'ordered'}]}), postnlMail(), nov16, known);
	assert.deepEqual(confirmation.rejected, ['no tracking code yet (order confirmation?)']);
});

test('a codeless email for a parcel not known yet becomes a hint, used by the next parcel of that shop', () => {
	const {readings, hint} = validate(postnlAnswer(), postnlMail(), nov16, []);
	assert.equal(readings.length, 0);
	assert.equal(hint.shop, 'Zalando');
	assert.equal(hint.windowStart, '13:15');
	assert.ok(hintFits(hint, {shop: 'Zalando', carrier: 'postnl'}, nov16));
	assert.ok(!hintFits(hint, {shop: 'Coolblue', carrier: 'postnl'}, nov16));
	assert.ok(!hintFits(hint, {shop: 'Zalando', carrier: 'dhl'}, nov16));
	assert.ok(!hintFits(hint, {shop: 'Zalando', carrier: 'postnl'}, new Date('2026-11-24T19:00:00+01:00')));
});

test('inbound: PostNL first, then the shop: the parcel gets the day and window', async () => {
	const world = fakeWorld([postnlAnswer(), zalandoAnswer]);
	try {
		const {handle} = require('../api/inbound');
		assert.equal((await handle(postnlMail(), env)).result, 'hint');
		assert.equal(world.store.hints.length, 1);
		await handle(zalandoMail(), env);
		const p = JSON.parse(world.store.hash['3STBKH585136340']);
		// Zalando's email is newer: its range wins; PostNL's window fills in.
		assert.deepEqual([p.expectedDate, p.expectedDateLast, p.windowStart, p.windowEnd], ['2026-11-17', '2026-11-18', '13:15', '15:15']);
		assert.equal(world.store.hints.length, 0);
		assert.match(world.store.log[0].result, /with an earlier codeless email/);
	} finally {
		world.restore();
	}
});

test('inbound: the shop first, then PostNL without a code: matched by shop', async () => {
	const world = fakeWorld([zalandoAnswer, postnlAnswer({known_parcel: '3STBKH585136340'})]);
	try {
		const {handle} = require('../api/inbound');
		await handle(zalandoMail(), env);
		const later = postnlMail({Date: '2026-11-17T07:00:00+01:00', Subject: 'Vandaag: je pakket van Zalando'});
		const out = await handle(later, env);
		assert.equal(out.result, 'parcel');
		const p = JSON.parse(world.store.hash['3STBKH585136340']);
		assert.deepEqual([p.expectedDate, p.expectedDateLast, p.windowStart], ['2026-11-17', null, '13:15']);
		assert.match(world.store.log[0].result, /matched by shop/);
	} finally {
		world.restore();
	}
});

test("PostNL's html with the whole body inside <head> still reads", () => {
	const html = '<html><head><title>PostNL</title><style>p{color:red}</style><!--[if mso]><style>x{}</style><![endif]--><body><h1>Hoi, we bezorgen binnenkort je pakket van Zalando</h1><p><b>Track &amp; trace-code</b><br>3STBKH585136340</p></body></head></html>';
	const m = normalise({Subject: 'Verwacht: je pakket van Zalando', HtmlBody: html, TextBody: ''});
	assert.match(m.text, /je pakket van Zalando/);
	assert.match(m.text, /3STBKH585136340/);
	assert.doesNotMatch(m.text, /color:red|PostNL$/);
});

test('the plain text is used when the html gives nothing', () => {
	const m = normalise({Subject: 'x', HtmlBody: '<html><body><img src="a.png"></body></html>', TextBody: 'Track & Trace: 3SCOOL1234567, morgen tussen 10:00 en 12:00'});
	assert.match(m.text, /3SCOOL1234567/);
});
