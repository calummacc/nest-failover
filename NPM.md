```bash
yarn version --patch
git push
git tag v$(node -p "require('./package.json').version")
git push origin --tags
```