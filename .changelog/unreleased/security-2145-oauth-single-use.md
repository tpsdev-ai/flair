- **OAuth authorization codes and refresh tokens are single-use across workers of one instance (flair#2145).**
  If the replay store cannot confirm use, token issuance is refused; boot reports store-configuration gaps.
