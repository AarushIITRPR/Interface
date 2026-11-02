import assert from "node:assert/strict";

export async function consentToStudy(subject){
  const submit=subject.getByRole("button",{name:"Give consent",exact:true});
  await submit.waitFor();
  const boxes=subject.getByRole("checkbox");
  assert.equal(await boxes.count(),3);
  for(let i=0;i<3;i++){
    assert.ok(await submit.isDisabled());
    await boxes.nth(i).check();
  }
  await submit.click();
}

// Separate browser contexts model two workstations; localhost is only a test transport.
export async function enrollStation(instructor,subject){
  await instructor.getByRole("heading",{name:"Connect the subject computer",exact:true}).waitFor();
  await instructor.getByText("Test both portals on this computer instead",{exact:true}).click();
  await instructor.getByRole("button",{name:"Create local test invitation"}).click();
  const invite=await instructor.getByLabel("Private subject invitation").inputValue();
  await subject.goto(invite);
  await subject.getByRole("button",{name:"Pair this subject computer",exact:true}).click();
  await consentToStudy(subject);
  const link=subject.getByRole("link",{name:"Connect recorder",exact:true});
  await link.waitFor();
  await subject.getByText("First time on this computer?",{exact:true}).click();
  await subject.getByRole("link",{name:/Install Meridian Recorder for Windows/}).waitFor();
  assert.equal(new URL(subject.url()).hash,"");
  await instructor.getByRole("heading",{name:"Wait for the subject recorder",exact:true}).waitFor();
  return {invite,link:new URL(await link.getAttribute("href"))};
}
