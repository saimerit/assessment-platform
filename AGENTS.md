# Assessment platform implementation tracking

The user requested implementation of the review roadmap in priority/dependency
order, with a pause for review after each feature section and a persistent checklist.

- Use [docs/feature-checklist.md](docs/feature-checklist.md) as the ongoing feature
  tracker. It contains priorities, dependencies, existing functionality, remaining
  work and review gates. Follow the user's latest direction if scope/order changes.
- Before feature work, read the current position and relevant checklist section.
  Resolve required dependencies before implementing the next section.
- After completing a feature section, update its implementation/test checkboxes,
  status, evidence links, next action and dated progress history.
- Keep partial work unchecked with a note. Separate implementation, automated
  checks, user acceptance and deployment. Never infer acceptance from a status
  question or a request to update documentation.
- At a review boundary, stop feature implementation and provide concrete setup,
  test steps and expected results in a linked checkpoint document.
- Preserve shared domain rules, SOLID responsibilities, reusable UI components,
  organization isolation and the worker-only answer vault. Avoid redundant code.
- Follow applicable nested AGENTS.md guidance when working inside subprojects.
