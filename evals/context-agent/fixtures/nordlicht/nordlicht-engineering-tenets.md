# Nordlicht engineering tenets

*How our engineering team makes technology choices. Fictional document for testing the T4Tangerine Stack Optimizer.*

1. **Managed beats self-run.** We have no operations team. If a cloud provider can run it for us at a fair price, we let them. We do not run our own Kubernetes clusters, databases or mail servers.

2. **One tool per job.** Two tools that do the same thing cost twice and confuse people. Before adding a tool, we remove one.

3. **Boring technology.** We choose well-known, widely used services that new hires already know, over clever or niche ones.

4. **Cost is a feature.** Every engineer can see what our services cost. We turn off what we do not use and review the cloud bill every month.

5. **Customer trust first.** Customer data stays in the EU and is handled only by approved providers, even when another option is cheaper.

6. **Small, reversible steps.** We change one part of the system at a time, with a way back. Big migrations are split into phases with a clear finish line.
