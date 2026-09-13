#!/usr/bin/env bash
# GitHub Releases 에 DMG 를 올린다. 로컬에서 빌드해 올리는 방식이다 —
# 서명·공증을 하지 않아 CI 로 옮길 이유가 없고, 받는 쪽은 어차피 첫 실행 때 우클릭 → 열기를 해야 한다.
#
#   scripts/release.sh            현재 package.json 버전으로
#   scripts/release.sh 0.2.0      버전을 올리고(커밋까지) 릴리스
#   DRY_RUN=1 scripts/release.sh  실제로 올리지 않고 할 일만 보여 준다
set -euo pipefail

cd "$(dirname "$0")/.."

NEW_VERSION="${1:-}"
DRY_RUN="${DRY_RUN:-}"

die() { echo "✗ $*" >&2; exit 1; }
step() { echo; echo "▸ $*"; }
run() { if [[ -n "$DRY_RUN" ]]; then echo "  (dry-run) $*"; else "$@"; fi; }

# ===== 올리기 전에 막을 것들 =====
command -v gh >/dev/null || die "gh 가 없다. brew install gh"
gh auth status >/dev/null 2>&1 || die "gh 로그인이 안 돼 있다. gh auth login"
git remote get-url origin >/dev/null 2>&1 || die "origin 원격이 없다. 먼저 GitHub 레포를 만들고 붙일 것."

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" == "main" ]] || die "main 에서만 릴리스한다 (지금: $BRANCH)"
[[ -z "$(git status --porcelain)" ]] || die "작업 트리가 깨끗하지 않다. 커밋하거나 되돌릴 것."

# ===== 버전 =====
if [[ -n "$NEW_VERSION" ]]; then
  [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "버전 형식은 x.y.z (받은 값: $NEW_VERSION)"
  step "버전 올리기 → $NEW_VERSION"
  run node -e "
    const fs=require('fs');
    const p='package.json'; const j=JSON.parse(fs.readFileSync(p,'utf8'));
    j.version=process.argv[1];
    fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
  " "$NEW_VERSION"
  run git add package.json
  run git commit -m "v$NEW_VERSION"
fi

VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
DMG="release/atelier-${VERSION}-arm64.dmg"

git rev-parse "$TAG" >/dev/null 2>&1 && die "$TAG 태그가 이미 있다. 버전을 올릴 것."
gh release view "$TAG" >/dev/null 2>&1 && die "$TAG 릴리스가 이미 GitHub 에 있다."

# ===== 검증하고 빌드 =====
step "타입체크·테스트"
run yarn typecheck
run yarn test

step "패키징 (몇 분 걸린다)"
run yarn package
[[ -n "$DRY_RUN" || -f "$DMG" ]] || die "$DMG 가 만들어지지 않았다."

# ===== 릴리스 노트 =====
# 지난 태그 이후의 커밋 제목. 첫 릴리스면 전체.
PREV_TAG="$(git tag --list 'v*' --sort=-v:refname | head -1)"
if [[ -n "$PREV_TAG" ]]; then
  LOG="$(git log --format='- %s' "${PREV_TAG}..HEAD")"
else
  LOG="$(git log --format='- %s' -20)"
fi
NOTES="$(cat <<EOF
${LOG}

---

**설치**: 아래 DMG 를 받아 열고 \`Atelier.app\` 을 Applications 로 드래그한다.

서명·공증을 하지 않아 Gatekeeper 가 막는다. 터미널에서 격리 속성을 떼는 것이 가장 확실하다:
\`\`\`
xattr -d com.apple.quarantine /Applications/Atelier.app
\`\`\`
또는 한 번 열어 본 뒤 **시스템 설정 → 개인정보 보호 및 보안** 에서 "그래도 열기".
(우클릭 → 열기 는 macOS 15 Sequoia 부터 통하지 않는다.)

**필요한 것**: Apple Silicon Mac, 그리고 이미 로그인해 둔 \`claude\` 또는 \`codex\` CLI.
EOF
)"

step "태그 $TAG 를 만들고 올린다"
run git tag -a "$TAG" -m "$TAG"
run git push origin main
run git push origin "$TAG"

step "릴리스 만들기 ($DMG)"
if [[ -n "$DRY_RUN" ]]; then
  echo "  (dry-run) gh release create $TAG $DMG --title $TAG --notes …"
  echo "$NOTES" | sed 's/^/    | /'
else
  gh release create "$TAG" "$DMG" --title "$TAG" --notes "$NOTES"
fi

step "끝"
[[ -n "$DRY_RUN" ]] || gh release view "$TAG" --web >/dev/null 2>&1 || true
echo "  $TAG · $(du -h "$DMG" 2>/dev/null | cut -f1 || echo '?') · $(git remote get-url origin)"
