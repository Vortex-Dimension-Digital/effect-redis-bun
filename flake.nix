{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    git-hooks = {
      url = "github:cachix/git-hooks.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      nixpkgs,
      flake-parts,
      git-hooks,
      ...
    }@inputs:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = nixpkgs.lib.systems.flakeExposed;

      imports = [
        git-hooks.flakeModule
      ];

      perSystem =
        {
          pkgs,
          config,
          ...
        }:
        {
          formatter = pkgs.nixfmt-tree;

          pre-commit = {
            check.enable = true;

            settings.hooks = {
              biome.enable = true;

              bun-test = {
                enable = true;
                name = "bun test";
                entry = "${pkgs.bun}/bin/bun test";
                language = "system";
                pass_filenames = false;
                stages = [ "pre-push" ];
              };
            };
          };
          devShells.default =
            let
              inherit (config.pre-commit) shellHook;
              inherit (config.pre-commit.settings) enabledPackages;
            in
            pkgs.mkShell {
              inherit shellHook;

              packages = enabledPackages ++ [
                pkgs.bun
                pkgs.git
              ];
            };
        };
    };
}
