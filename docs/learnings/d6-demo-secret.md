# D6: Build pull requests without the demo key

## Decision

Keep the demo key available for intended push and manual runs. Pull request runs do not receive that key. They build the demo image and skip the authenticated render.

## Rejected alternative

Removing the pull request trigger loses the image build check instead of omitting the demo credential.
