# Proposals — API Reference

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/proposals` | Create a proposal |
| `GET` | `/proposals` | Get paginated list |
| `GET` | `/proposals/:id` | Get single proposal |
| `PUT` | `/proposals/:id` | Update proposal |
| `DELETE` | `/proposals/:id` | Delete proposal |
| `GET` | `/proposals/:id/chat` | Get chat history |
| `POST` | `/proposals/:id/analyze` | Analyze proposal intent (AI) |

All endpoints require `Authorization: Bearer <token>`.

---

## POST /proposals

### Request Body

```json
{
  "title": "Full Stack Developer — MVP Project",
  "accountId": "uuid-of-account",
  "platformId": "uuid-of-platform",
  "proposalType": "Bid",
  "jobUrl": "~01abc1234567890def",
  "boosted": true,
  "connects": 6,
  "boostedConnects": 14,
  "coverLetter": "Dear client, ...",
  "vacancy": "We are looking for a React developer..."
}
```

### Fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `title` | `string` | **yes** | — | Назва пропозалу |
| `accountId` | `string` (UUID) | **yes** | — | ID акаунту з `/accounts` |
| `platformId` | `string` (UUID) | **yes** | — | ID платформи з `/platforms` |
| `proposalType` | `string` (enum) | **yes** | — | `Bid` \| `Invite` \| `DirectMessage` |
| `jobUrl` | `string` | no | `null` | URL або ID джобу на платформі |
| `boosted` | `boolean` | no | `false` | Чи є пропозал бустованим. Тільки для `Bid` |
| `connects` | `number` | no | `0` | Витрачені connects. Тільки для `Bid` |
| `boostedConnects` | `number` | no | `0` | Connects на буст. Тільки якщо `boosted: true` і `proposalType: Bid` |
| `coverLetter` | `string` | no | `null` | Текст cover letter |
| `vacancy` | `string` | no | `null` | Текст вакансії (для контексту AI чату) |

> **Правило connects:** якщо `proposalType` не `Bid` — поля `boosted`, `connects`, `boostedConnects` ігноруються і встановлюються в `false` / `0` / `0`.
> Якщо `boosted: false` — `boostedConnects` завжди `0`.

---

## GET /proposals

### Query Params

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | `number` | `1` | Номер сторінки |
| `limit` | `number` | `10` | Елементів на сторінці |

### Response

```json
{
  "data": [ { ...proposal } ],
  "total": 42
}
```

Пагінація: `pages = Math.ceil(total / limit)`. Список відсортований за датою створення (новіші перші).

---

## Response Object

```json
{
  "id": "uuid",
  "title": "Full Stack Developer — MVP Project",
  "status": "Draft",
  "proposalType": "Bid",
  "jobUrl": "~01abc1234567890def",
  "boosted": true,
  "connects": 6,
  "boostedConnects": 14,
  "coverLetter": "Dear client, ...",
  "vacancy": "We are looking for a React developer...",
  "sentAt": null,
  "createdAt": "2026-04-16T12:00:00Z",
  "updatedAt": "2026-04-16T12:00:00Z",
  "userId": "uuid",
  "accountId": "uuid",
  "platformId": "uuid",
  "user": {
    "id": "uuid",
    "email": "admin@test.com",
    "firstName": "Dmytro",
    "lastName": "Sarafaniuk"
  },
  "account": {
    "id": "uuid",
    "firstName": "Dmytro",
    "lastName": "Sarafaniuk",
    "platformId": "uuid",
    "userId": "uuid",
    "createdAt": "2026-04-16T12:00:00Z",
    "updatedAt": "2026-04-16T12:00:00Z",
    "platform": {
      "id": "00000000-0000-0000-0000-000000000001",
      "title": "Upwork",
      "slug": "upwork",
      "imageUrl": null
    }
  },
  "platform": {
    "id": "00000000-0000-0000-0000-000000000001",
    "title": "Upwork",
    "slug": "upwork",
    "imageUrl": null
  }
}
```

> `platform` на рівні пропозалу — платформа, вибрана при створенні.
> `account.platform` — платформа, прив'язана до акаунту.
> Рекомендується передавати однакові, але бекенд не валідує відповідність.

---

## PUT /proposals/:id

Всі поля опціональні — передавати тільки те, що змінюється.

```json
{
  "status": "Sent",
  "coverLetter": "Updated cover letter...",
  "boosted": true,
  "connects": 8,
  "boostedConnects": 14,
  "accountId": "uuid-of-account",
  "platformId": "uuid-of-platform"
}
```

> Коли `status` змінюється на `Sent` — `sentAt` встановлюється автоматично.

---

## Enums

### `status`
| Value | Description |
|-------|-------------|
| `Draft` | Чернетка (default) |
| `Sent` | Відправлено |
| `Viewed` | Переглянуто клієнтом |
| `Replied` | Клієнт відповів |

### `proposalType`
| Value | Description |
|-------|-------------|
| `Bid` | Звичайна ставка |
| `Invite` | Запрошення від клієнта |
| `DirectMessage` | Пряме повідомлення |

---

## Notes

- `id`, `createdAt`, `updatedAt` — генеруються бекендом автоматично.
- `sentAt` — встановлюється автоматично при першій зміні `status → Sent`.
- `user` в відповіді — власник пропозалу (залогінений користувач).
- Перед створенням пропозалу необхідно мати хоча б один акаунт (`POST /accounts`) і знати ID платформи (`GET /platforms`).
