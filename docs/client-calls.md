# Client Calls API

## Overview

Client Calls дозволяє планувати дзвінки з лідами або client-request. При створенні вказується тип клієнта, пов'язана сутність, дата/час, timezone клієнта та тривалість. Бекенд автоматично обчислює `clientDateTime` і `kyivDateTime` у кожному відповіді — зберігати їх не потрібно.

**Base path:** `/client-calls`  
**Auth:** `Bearer {{token}}` — всі ендпоінти захищені JWT

---

## Flow

```
1. Обрати clientType: "lead" | "client_request"
2. Передати leadId або clientRequestId (залежно від типу)
3. Вказати callTitle, scheduledAt (UTC ISO), clientTimezone, duration
4. Бекенд повертає clientDateTime та kyivDateTime у відповіді
5. Після дзвінку — PATCH з notes, summary, transcriptUrl, aiSummary
```

---

## Enums

| Enum | Values |
|------|--------|
| `clientType` | `lead` \| `client_request` |
| `status` | `scheduled` \| `cancelled` \| `completed` |

---

## Endpoints

### POST /client-calls

Створити новий call.

**Request body:**

```json
{
  "clientType": "lead",
  "leadId": "uuid-of-lead",
  "callTitle": "Discovery Call",
  "meetingUrl": "https://meet.google.com/abc-xyz",
  "scheduledAt": "2026-05-01T12:00:00.000Z",
  "clientTimezone": "America/New_York",
  "duration": 60
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `clientType` | `"lead" \| "client_request"` | yes | Тип клієнта |
| `leadId` | `string (uuid)` | if clientType = lead | ID ліда |
| `clientRequestId` | `string (uuid)` | if clientType = client_request | ID client request |
| `callTitle` | `string` | yes | Назва дзвінку |
| `meetingUrl` | `string (url)` | no | Посилання на Zoom/Meet |
| `scheduledAt` | `string (ISO 8601 UTC)` | yes | Дата/час в UTC |
| `clientTimezone` | `string` | yes | IANA (`America/New_York`) або offset (`+05:00`) |
| `duration` | `number (int)` | yes | Тривалість в хвилинах |

**Response — 201 Created:**

```json
{
  "id": "uuid",
  "clientType": "lead",
  "leadId": "uuid-of-lead",
  "clientRequestId": null,
  "createdById": "uuid-of-user",
  "callTitle": "Discovery Call",
  "meetingUrl": "https://meet.google.com/abc-xyz",
  "scheduledAt": "2026-05-01T12:00:00.000Z",
  "clientTimezone": "America/New_York",
  "duration": 60,
  "status": "scheduled",
  "notes": null,
  "summary": null,
  "transcriptUrl": null,
  "aiSummary": null,
  "createdAt": "2026-04-27T18:55:10.000Z",
  "updatedAt": "2026-04-27T18:55:10.000Z",
  "clientDateTime": "2026-05-01 08:00",
  "kyivDateTime": "2026-05-01 15:00"
}
```

**Errors:**
- `400` — `leadId` відсутній для `clientType: "lead"` (або навпаки)
- `404` — Lead або ClientRequest не знайдено

---

### GET /client-calls

Список дзвінків з пагінацією, відсортований по `scheduledAt` desc.

**Query params:**

| Param | Default | Description |
|-------|---------|-------------|
| `page` | `1` | Номер сторінки |
| `limit` | `10` | Кількість на сторінку |

**Response — 200 OK:**

```json
{
  "data": [
    {
      "id": "uuid",
      "clientType": "lead",
      "callTitle": "Discovery Call",
      "scheduledAt": "2026-05-01T12:00:00.000Z",
      "clientTimezone": "America/New_York",
      "duration": 60,
      "status": "scheduled",
      "clientDateTime": "2026-05-01 08:00",
      "kyivDateTime": "2026-05-01 15:00",
      "lead": {
        "id": "uuid",
        "firstName": "John",
        "lastName": "Doe",
        "companyName": "Acme Corp"
      },
      "clientRequest": null,
      "createdBy": {
        "id": "uuid",
        "firstName": "Dmytro",
        "lastName": "Sarafaniuk"
      }
    }
  ],
  "total": 42
}
```

---

### GET /client-calls/:id

Отримати конкретний call з усіма полями та вкладеними сутностями.

**Response — 200 OK:** аналогічно елементу з `GET /client-calls`, але з усіма полями включаючи `notes`, `summary`, `transcriptUrl`, `aiSummary`.

**Errors:**
- `404` — Call не знайдено

---

### PATCH /client-calls/:id

Оновити call. Всі поля опціональні.

**Request body:**

```json
{
  "status": "completed",
  "notes": "Client is interested, follow up next week.",
  "summary": "Discussed project scope and timeline.",
  "transcriptUrl": "https://f003.backblazeb2.com/file/bucket/transcript-uuid.txt",
  "aiSummary": "Key points: budget ~$5k, timeline 2 months, React + Node stack preferred."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `callTitle` | `string` | Оновити назву |
| `meetingUrl` | `string (url)` | Оновити посилання |
| `scheduledAt` | `string (ISO 8601 UTC)` | Перенести дзвінок |
| `clientTimezone` | `string` | Оновити timezone |
| `duration` | `number (int)` | Оновити тривалість |
| `status` | `"scheduled" \| "cancelled" \| "completed"` | Змінити статус |
| `notes` | `string` | Нотатки після дзвінку |
| `summary` | `string` | Коротке резюме дзвінку |
| `transcriptUrl` | `string` | URL файлу транскрипції (Backblaze) |
| `aiSummary` | `string` | AI-вижимка з транскрипту |

**Response — 200 OK:** оновлений call об'єкт з `clientDateTime` та `kyivDateTime`.

**Errors:**
- `404` — Call не знайдено

---

### DELETE /client-calls/:id

Видалити call.

**Response — 204 No Content**

**Errors:**
- `404` — Call не знайдено

---

## Timezone handling

`clientTimezone` приймає два формати:

| Формат | Приклад | Поведінка |
|--------|---------|-----------|
| IANA timezone | `America/New_York`, `Europe/London` | Враховує DST автоматично |
| Fixed offset | `+05:00`, `-03:00`, `+5` | Фіксований зсув, без DST |

`scheduledAt` завжди зберігається як UTC. `clientDateTime` та `kyivDateTime` обчислюються бекендом при кожному запиті.

---

## Cascade delete

Якщо Lead або ClientRequest видаляється — всі прив'язані `ClientCall` видаляються автоматично (ON DELETE CASCADE).
