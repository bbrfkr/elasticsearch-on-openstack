import { App } from "cdktf";
import { ElasticsearchStack } from "./src/elasticsearch";

const app = new App();
new ElasticsearchStack(app, "elasticsearch-on-openstack");
app.synth();
