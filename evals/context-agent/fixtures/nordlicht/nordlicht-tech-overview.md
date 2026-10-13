# Nordlicht Analytics S.à r.l. — Technology overview and policies (2026)

*Internal document. Fictional company, for testing the T4Tangerine Stack Optimizer.*

## About us

Nordlicht Analytics is a Luxembourg-based B2B software company (SaaS) that helps logistics firms forecast delivery demand. We have 32 employees, of which 14 are engineers, and about 120 business customers across the EU.

## What we run today

| Area | Tool | Cost | Notes |
|---|---|---|---|
| Website & app hosting | Vercel Pro | $60 per month | 3 seats, marketing site and customer app |
| Servers | Heroku, 6 Standard-2X dynos | $300 per month | Main API and background jobs |
| Main database | Heroku Postgres Standard-4 | $750 per month | About 300 GB of customer data |
| Speed-up cache | Redis Cloud | €95 per month | Sessions and job queues |
| File storage | Dropbox Business | €1,440 per year | Customer exports and reports |
| Monitoring & logs | Datadog | about $9,000 per year | 8 hosts, logs kept 15 days |
| User login | Auth0 B2B Essentials | $240 per month | About 2,500 business users |
| AI services | OpenAI API | $400 per month | Forecast explanations for customers |
| Build & release | GitHub Team and GitHub Actions | $520 per month | 14 developers |
| Team tools | Slack Pro, Notion Plus, Jira Standard | | Costs are on the company card |

## Rules every technology decision must follow

1. **Customer data stays in the EU.** All customer data must be stored and processed in EU data centres (customer contracts and GDPR).
2. **Approved cloud providers:** AWS and Microsoft Azure only. New vendors that handle customer data need approval from the security lead.
3. **Uptime:** our customer contracts promise 99.9% availability.
4. **Team:** we have no dedicated operations team, so we prefer fully managed services over running our own servers.

## Goals for next year

- Cut technology spend by **20%** before the January renewals.
- Reduce the number of separate tools and vendors.
- Keep the engineering team focused on product work, not on maintaining infrastructure.
