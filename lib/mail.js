const crypto = require('node:crypto');

/**
 * Turns whatever delivered an email into one plain shape:
 *   {from, to, subject, date, text}
 *
 * Accepted: Postmark's inbound webhook JSON (From, Subject, TextBody,
 * HtmlBody, …), or a generic {from, to, subject, date, text, html} object, which
 * is what a future Proton Mail Bridge poller would send.
 */

const MAX_TEXT = 12000; // plenty for a shipping email; keeps the Claude call small

function decodeEntities(s) {
	return s
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/* HTML to readable text, keeping link targets ("Track (https://…)") because
   tracking links often carry the code and the postcode. */
function htmlToText(html = '') {
	return decodeEntities(
		String(html)
			// Not <head> as a whole: some senders (PostNL) put the entire <body>
			// inside <head>, which would leave nothing. Its parts go one by one.
			.replace(/<!--[\s\S]*?-->/g, ' ')
			.replace(/<(script|style|title|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
			.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
				const text = label.replace(/<[^>]+>/g, ' ').trim();
				return /^https?:/i.test(href) ? ` ${text} (${href}) ` : ` ${text} `;
			})
			.replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)[^>]*>/gi, '\n')
			.replace(/<[^>]+>/g, ' ')
	)
		.replace(/[ \t\f\v]+/g, ' ')
		.replace(/\n\s*\n+/g, '\n')
		.trim();
}

/* A stable id per email: its Message-ID header when there is one, otherwise a
   hash of sender, subject, date and the start of the text. */
function emailId(body, mail) {
	const header = (body.Headers || []).find((h) => /^message-id$/i.test(h.Name))?.Value || body.messageId || body.MessageID || '';
	const basis = header || `${mail.from}|${mail.subject}|${mail.date}|${mail.text.slice(0, 2000)}`;
	return crypto.createHash('sha256').update(String(basis)).digest('hex').slice(0, 32);
}

function normalise(body = {}) {
	const mail = shape(body);
	mail.id = emailId(body, mail);
	return mail;
}

function shape(body = {}) {
	if (body.Subject !== undefined || body.TextBody !== undefined || body.HtmlBody !== undefined) {
		// The HTML is read first (it has the links); the plain text is the
		// fallback when the HTML gives (next to) nothing.
		const fromHtml = body.HtmlBody ? htmlToText(body.HtmlBody) : '';
		const text = fromHtml.length >= 40 ? fromHtml : String(body.TextBody || '').trim() || fromHtml;
		return {
			from: body.FromFull?.Email || body.From || '',
			fromName: body.FromFull?.Name || body.FromName || '',
			to: body.OriginalRecipient || body.To || '',
			subject: String(body.Subject || ''),
			date: body.Date || new Date().toISOString(),
			text: text.slice(0, MAX_TEXT),
		};
	}
	const fromHtml = body.html ? htmlToText(body.html) : '';
	const text = fromHtml.length >= 40 ? fromHtml : String(body.text || '').trim() || fromHtml;
	return {
		from: String(body.from || ''),
		fromName: String(body.fromName || ''),
		to: String(body.to || ''),
		subject: String(body.subject || ''),
		date: body.date || new Date().toISOString(),
		text: text.slice(0, MAX_TEXT),
	};
}

/* Proton asks the receiving address to accept forwarding with a link. That
   email has to reach you, not the parser. */
function forwardingConfirmation(mail) {
	if (!/proton/i.test(mail.from) || !/forward/i.test(`${mail.subject} ${mail.text}`)) return null;
	const links = mail.text.match(/https:\/\/[^\s)"'<>]+/g) || [];
	const link = links.find((l) => /proton\.me|protonmail\.com/i.test(l) && /forward|accept|confirm/i.test(l)) || links.find((l) => /proton/i.test(l));
	return link ? {link} : {link: null};
}

module.exports = {normalise, htmlToText, forwardingConfirmation, MAX_TEXT};
