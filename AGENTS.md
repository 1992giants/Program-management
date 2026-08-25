# AGENTS.md

# Project Instructions for Codex

## 1. Core Principle

Preserve existing functionality and product direction.

When working on this project:

* Prefer small, targeted changes.
* Do not redesign working screens unless explicitly requested.
* Do not change business logic for visual/UI tasks.
* Do not modify API contracts, authentication logic, database schemas, or data models unless explicitly requested.
* Avoid unrelated refactoring.
* Avoid changing files unrelated to the current task.
* Prefer the smallest reasonable diff.

Before making a change, inspect the surrounding code and existing project patterns.

---

## 2. UI / UX Polish

When the user asks to:

* polish a screen
* improve details
* improve UI
* clean up the interface
* increase visual quality
* fix minor inconsistencies

actively inspect the relevant screen and nearby components.

Do not wait for every minor issue to be individually specified.

Look for obvious opportunities to improve:

### Spacing

Check:

* padding
* margin
* gap
* section spacing
* card spacing
* vertical rhythm

Similar components should use similar spacing.

Avoid arbitrary one-off spacing values when an existing project convention can be reused.

### Alignment

Check:

* vertical alignment
* horizontal alignment
* text/icon alignment
* button alignment
* card alignment
* baseline inconsistencies

Fix small alignment problems when the intended layout is obvious.

### Typography

Check:

* font size
* font weight
* line height
* text hierarchy
* muted text
* labels
* headings
* body copy

Maintain a clear visual hierarchy.

Do not introduce unnecessary font sizes or weights.

Reuse existing typography patterns whenever possible.

### Components

Check consistency across:

* buttons
* inputs
* textareas
* select controls
* cards
* modals
* dialogs
* tabs
* badges
* navigation
* tables
* lists

Similar components should look and behave consistently.

### Icons

Check:

* icon size
* icon alignment
* spacing between icon and text
* visual weight
* button/icon balance

Do not mix inconsistent icon sizing without a reason.

---

## 3. Interaction Polish

Where appropriate, verify:

* hover
* focus
* active
* selected
* disabled
* loading
* error
* empty
* success states

Interactive elements should clearly appear interactive.

Ensure buttons and clickable controls have appropriate:

* cursor behavior
* hover feedback
* focus visibility
* disabled feedback
* loading feedback

Avoid excessive animation.

Use subtle transitions only when they improve interaction clarity.

---

## 4. Responsive Behavior

When changing UI, check whether the modification could affect smaller screens.

Inspect for:

* horizontal overflow
* clipped text
* broken wrapping
* overflowing buttons
* oversized fixed widths
* cramped padding
* cards wider than the viewport
* awkward mobile stacking
* navigation breakage

Prefer responsive layouts over device-specific hacks.

Do not introduce fixed dimensions unless they are appropriate for the design.

---

## 5. Visual Consistency

Before creating a new UI pattern:

1. Search the project for an existing equivalent.
2. Reuse existing components when appropriate.
3. Reuse existing spacing, typography, radius, border, and shadow conventions.
4. Only introduce a new pattern when the existing system cannot reasonably handle the requirement.

Avoid having multiple visual solutions for the same UI problem.

---

## 6. Design Restraint

UI polish should generally be subtle.

Prefer:

* better spacing
* better alignment
* clearer hierarchy
* consistent sizing
* cleaner states
* improved readability

over:

* decorative gradients
* excessive shadows
* unnecessary animation
* large visual redesigns
* arbitrary color additions
* excessive rounded containers
* unnecessary cards around content

Do not make changes merely to make the diff larger.

If the current design is already reasonable, leave it alone.

---

## 7. Preserve Product Intent

Do not remove or simplify information solely for aesthetic reasons.

Do not:

* remove user actions
* hide important information
* merge distinct controls
* change navigation hierarchy
* alter user workflows

unless explicitly requested.

UX improvements should preserve existing intent.

---

## 8. Refactoring Rules

During UI polish tasks:

Do not perform large-scale refactoring unless required to make the requested change safely.

Avoid:

* renaming unrelated variables
* reorganizing folders
* moving files unnecessarily
* rewriting working components from scratch
* converting patterns solely based on personal preference
* replacing libraries without a clear reason

Small cleanup directly related to the task is allowed.

---

## 9. Dependencies

Do not add a new dependency if the same result can reasonably be achieved using:

* existing project dependencies
* existing components
* existing utilities
* CSS
* the current UI system

If a new dependency is genuinely necessary, explain why before adding it when practical.

---

## 10. Code Quality

Follow existing project conventions.

Prefer:

* readable code
* clear component boundaries
* reuse over duplication
* straightforward implementations
* strongly typed code when TypeScript is used

Avoid unnecessary abstraction.

Do not create helper functions or components for trivial one-use logic unless it materially improves clarity.

---

## 11. Existing Components First

Before implementing a new component, search the codebase.

For example, before creating:

* a new button
* a new dialog
* a new card
* a new input
* a new toast
* a new loading indicator

check whether the project already contains an equivalent component.

Reuse and extend existing components when reasonable.

---

## 12. Minor Issues Codex May Fix Autonomously

When working on a screen, Codex may autonomously fix minor adjacent issues when:

* the issue is clearly unintended
* the fix is low risk
* the expected behavior is obvious
* the change is small
* it improves consistency

Examples:

* misaligned icons
* inconsistent padding
* inconsistent button heights
* obvious text overflow
* inconsistent border radius
* missing hover state
* minor responsive breakage
* accidental spacing discrepancies
* obvious visual duplication

Do not autonomously change subjective product/design decisions.

When uncertain, preserve the existing behavior.

---

## 13. Avoid Speculative Changes

Do not modify something merely because it could theoretically be improved.

Use this decision rule:

> If the improvement is clearly beneficial and low-risk, fix it.
> If the change is subjective or could alter product intent, leave it unchanged unless requested.

---

## 14. Validation

After completing meaningful code changes, run the relevant available checks.

Depending on project configuration, this may include:

```bash
npm run lint
```

```bash
npm run typecheck
```

```bash
npm run build
```

or equivalent project commands.

Do not blindly run nonexistent scripts.

Check `package.json` first.

When appropriate, also inspect the final diff for:

* accidental file changes
* unrelated formatting changes
* deleted behavior
* unintended dependencies
* debug code
* console logs

---

## 15. Build and Error Policy

Do not finish a task while knowingly leaving a new:

* TypeScript error
* lint error
* compilation error
* broken import
* runtime error

caused by the change.

If an error existed before the task, distinguish it from errors introduced by the current change.

---

## 16. Browser / Runtime Errors

When fixing runtime issues:

* identify the underlying cause first
* avoid suppressing errors without understanding them
* do not weaken security settings simply to remove warnings
* preserve development and production behavior where possible

For Next.js configuration changes, remember that server restart may be required before assuming a configuration change failed.

---

## 17. Final Review

Before considering a task complete:

1. Review the modified files.
2. Review the diff.
3. Confirm that the original requested behavior still works.
4. Confirm that unrelated behavior was not changed.
5. Check obvious responsive implications.
6. Remove debugging artifacts.
7. Run applicable validation commands.

---

## 18. Final Response

At the end of a task, give a concise summary containing:

### Changed

* What was changed.

### Files

* Important files modified.

### Validation

* Checks that were run.

### Notes

* Anything that should still be manually verified.

Do not produce a long narrative unless requested.

---

# Default UI Polish Behavior

When the user gives a broad instruction such as:

> "Polish this page."

or:

> "Improve the UI details."

interpret it as:

* inspect the relevant screen
* identify clear low-risk UI/UX inconsistencies
* fix them autonomously
* preserve the existing design direction
* preserve functionality
* avoid large redesign
* avoid unrelated refactoring
* validate the result

The goal is to make the application feel more deliberate, consistent, and finished without changing what the product fundamentally is.

---

## UX Principles

When improving UX, prioritize reducing user friction rather than adding visual decoration.

Evaluate complete user flows, not isolated screens.

Always consider:

- What is the user's goal on this screen?
- Is the primary next action obvious?
- Can unnecessary steps be removed?
- Can repeated input be avoided?
- Does every important action provide immediate feedback?
- Is the current system state visible?
- Are loading, success, error, and empty states handled?
- Can user mistakes be prevented?
- Can mistakes be easily recovered from?
- Are destructive actions appropriately protected?
- Are similar actions consistent across the product?
- Does the UI preserve the user's context after an action?

Prefer:

- fewer steps
- sensible defaults
- clear primary actions
- immediate feedback
- inline validation
- reversible actions
- preserved user input
- predictable navigation
- clear system status

Avoid:

- unnecessary confirmation dialogs
- unnecessary navigation
- hidden important actions
- ambiguous button labels
- silent background actions
- resetting user input unexpectedly
- making users repeat information already known by the system

Do not change established product workflows solely based on subjective preference.

When a UX change affects user flow or behavior, report the proposed change before implementing it unless the improvement is clearly low-risk.
