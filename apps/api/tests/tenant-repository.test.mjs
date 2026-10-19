import assert from "node:assert/strict";
import test from "node:test";
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
import { BaseTenantRepository } from "../dist/infrastructure/tenant-repository.js";

const db = new Kysely({ dialect: {
  createAdapter: () => new PostgresAdapter(), createDriver: () => new DummyDriver(),
  createIntrospector: (database) => new PostgresIntrospector(database), createQueryCompiler: () => new PostgresQueryCompiler()
} });
// An unrelated future module can inherit the pattern without depending on OrganizationStore.
class ExpenseRepository extends BaseTenantRepository {
  findById(organizationId, id) { return this.find(organizationId, db.selectFrom("expenses")).selectAll().where("id", "=", id); }
  updateById(organizationId, id) { return this.update(organizationId, db.updateTable("expenses")).set({ name: "Updated" }).where("id", "=", id); }
  deleteById(organizationId, id) { return this.delete(organizationId, db.deleteFrom("expenses")).where("id", "=", id); }
  verify(organizationId, resource) { return this.ensureOrganization(organizationId, resource); }
}
const repository = new ExpenseRepository();
test("find, update, and delete parameterize tenant scope alongside resource identity", () => {
  for (const method of ["findById", "updateById", "deleteById"]) {
    const query = repository[method]("tenant-a", "resource-b").compile();
    assert.match(query.sql, /where "organization_id" = \$\d and "id" = \$\d/);
    assert.deepEqual(query.parameters.slice(-2), ["tenant-a", "resource-b"]);
    assert.doesNotMatch(query.sql, /tenant-a|resource-b/);
    assert.throws(() => repository[method]("", "resource-b"), /Organization scope is required/);
  }
});
test("returned-resource guard fails closed for a foreign tenant", () => {
  const record = { organizationId: "tenant-a", id: "expense" };
  assert.equal(repository.verify("tenant-a", record), record);
  assert.throws(() => repository.verify("tenant-b", record), /invalid organization scope/);
});
