{
  description = "sidemux dev shell — shadows the global pnpm install with this checkout's local build";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      forAllSystems = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          # A flake's `./.` resolves to the git-tracked source copied into
          # /nix/store — an immutable snapshot, NOT the live working directory
          # (and dist/ is gitignored, so it wouldn't even be in that copy). So
          # the local-build wrapper can't be a store-baked writeShellScriptBin;
          # it's generated here at shell-activation time against the real $PWD,
          # which nix-direnv sets correctly per worktree.
          default = pkgs.mkShell {
            packages = [ pkgs.nodejs_22 pkgs.pnpm ];
            shellHook = ''
              mkdir -p .direnv/bin
              printf '#!/usr/bin/env bash\nexec ${pkgs.nodejs_22}/bin/node "%s/dist/index.js" "$@"\n' "$PWD" > .direnv/bin/sidemux
              chmod +x .direnv/bin/sidemux
              export PATH="$PWD/.direnv/bin:$PATH"
              if [ ! -f dist/index.js ]; then
                echo "sidemux: no dist/ yet — run: pnpm install && pnpm build" >&2
              fi
            '';
          };
        });
    };
}
