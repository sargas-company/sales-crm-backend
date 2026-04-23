# Leads — Breaking Changes & New Endpoints

Короткий список змін для фронтенду. Все інше (статуси, чати, пагінація) залишилось без змін.

---

## 1. Поле `leadName` → `firstName` + `lastName` + `companyName`

Поле `leadName` **видалено**. Замість нього три окремих поля.

### Зачіпає: `PATCH /leads/:id`

Було:
```json
{ "leadName": "John Doe" }
```

Стало:
```json
{
  "firstName": "John",
  "lastName": "Doe",
  "companyName": "Acme Corp"
}
```

### Всі поля в `PATCH /leads/:id`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `firstName` | `string` | no | Ім'я |
| `lastName` | `string` | no | Прізвище |
| `companyName` | `string` | no | Назва компанії (актуально для `clientType: "company"`) |
| `clientType` | `"individual" \| "company"` | no | Тип клієнта |
| `status` | `LeadStatus` | no | Статус ліда |
| `rate` | `number` | no | Рейт |
| `location` | `string` | no | Локація |

> Логіка на фронті: якщо `clientType === "company"` — показувати поле `companyName`.

---

## 2. Новий endpoint — `POST /leads`

Тепер лід можна створити вручну, без proposal.
При створенні автоматично створюється чат (як і для лідів з proposal).

### Request

`POST /leads`  
`Authorization: Bearer <token>`

```json
{
  "firstName": "John",
  "lastName": "Doe",
  "companyName": "Acme Corp",
  "clientType": "company",
  "rate": 50,
  "location": "United States"
}
```

Всі поля опціональні — можна створити порожній лід.

### Response — `201 Created`

```json
{
  "id": "uuid",
  "number": 42,
  "proposalId": null,
  "firstName": "John",
  "lastName": "Doe",
  "companyName": "Acme Corp",
  "clientType": "company",
  "status": "conversation_ongoing",
  "rate": 50,
  "location": "United States",
  "createdAt": "2026-04-17T18:00:00Z",
  "updatedAt": "2026-04-17T18:00:00Z",
  "repliedAt": "2026-04-17T18:00:00Z",
  "acceptedAt": null,
  "holdAt": null
}
```

---

## Незмінено

- `GET /leads` — пагінація без змін
- `GET /leads/:id` — структура відповіді та ж, крім `leadName` → `firstName`/`lastName`/`companyName`
- `GET /leads/:id/chat` — без змін
- `DELETE /leads/:id` — без змін
- Всі статуси (`LeadStatus`) — без змін
