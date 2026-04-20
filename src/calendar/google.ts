import { google } from 'googleapis';

interface EventData {
  title: string;
  description: string;
  startTime: Date;
  endTime?: Date;
  location?: string;
}

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON não configurado');

  const credentials = JSON.parse(raw);
  return new google.auth.JWT(
    credentials.client_email,
    undefined,
    credentials.private_key,
    ['https://www.googleapis.com/auth/calendar'],
  );
}

export async function createEvent(data: EventData): Promise<string | null> {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!calendarId) return null;

  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });

  const end = data.endTime ?? new Date(data.startTime.getTime() + 60 * 60 * 1000);

  const res = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary: data.title,
      description: data.description,
      location: data.location,
      start: { dateTime: data.startTime.toISOString(), timeZone: 'America/Sao_Paulo' },
      end: { dateTime: end.toISOString(), timeZone: 'America/Sao_Paulo' },
    },
  });

  return res.data.id ?? null;
}

export async function deleteEvent(eventId: string): Promise<void> {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  if (!calendarId) return;

  const auth = getAuth();
  const calendar = google.calendar({ version: 'v3', auth });
  await calendar.events.delete({ calendarId, eventId });
}
